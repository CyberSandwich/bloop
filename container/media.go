package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type probe struct {
	Streams []stream `json:"streams"`
	Format  struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
	} `json:"format"`
}

// video is the first video stream, the one ffmpeg maps as 0:v:0; ok is false when it has no size.
func (p probe) video() (w, h int, codec string, ok bool) {
	st, found := p.first("video")
	if !found {
		return 0, 0, "", false
	}
	return st.Width, st.Height, st.CodecName, st.Width > 0 && st.Height > 0
}

func (p probe) seconds() float64 {
	d, _ := strconv.ParseFloat(p.Format.Duration, 64)
	return d
}

// demuxerFor names the one ffmpeg demuxer an extension may use, so a file cannot pick another by content.
func demuxerFor(ext string) string {
	if ext == "webm" {
		return "matroska"
	}
	return "mov"
}

func (s *Server) probe(ctx context.Context, demuxer, path string) (probe, error) {
	out, err := s.tool(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file", "-f", demuxer,
		"-print_format", "json", "-show_format", "-show_streams", path)
	if err != nil {
		return probe{}, convertErr(err)
	}
	var p probe
	if err := json.Unmarshal(out, &p); err != nil {
		return probe{}, failed(errBadMedia, err)
	}
	return p, nil
}

const maxVideoDim = 8192

// videoJob probes the upload, copies it into an mp4 when it already is browser H.264 (no duration cap: the input
// size quota bounds it) or re-encodes it (capped at MaxVideoSecs), and takes a thumbnail. Each runs under a budget
// from the probed length or size, never over the video stage's timeout.
func (s *Server) videoJob(job jobInfo, meta *metaJSON) error {
	var an Analysis
	if err := s.stage("inspect", 2, func(ctx context.Context) error { return s.inspect(ctx, job, &an) }); err != nil {
		return err
	}
	orig := inputPath(s.cfg, job.ext)
	dst := s.dir("out", "m", "0.mp4")
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return failed(errInternal, err)
	}
	return s.stage("video", 5, func(ctx context.Context) error {
		demuxer := demuxerFor(job.ext)
		p, err := s.probe(ctx, demuxer, orig)
		if err != nil {
			return err
		}
		w, h, _, ok := p.video()
		seconds := p.seconds()
		if !ok || w > maxVideoDim || h > maxVideoDim || !(seconds > 0) || math.IsInf(seconds, 0) {
			return failed(errBadMedia, fmt.Errorf("video %dx%d, %.0f s, stream %v", w, h, seconds, ok))
		}
		// An index that cannot be read means a transcode: ffmpeg decides what the file is.
		boxes, _ := topBoxes(orig)
		remux := canRemux(p, demuxer, s.cfg.VideoWidth, boxes)
		if remux {
			// A copy drops the SEI units, and with them the recovery point a stream without an IDR starts from.
			if idr, err := s.startsWithIDR(ctx, orig); err != nil || !idr {
				remux = false
			}
		}
		ceiling := s.cfg.Timeouts["video"]
		budget := transcodeBudget(seconds, s.cfg.VideoRate, s.cfg.VideoFixed, ceiling)
		st, err := os.Stat(orig)
		if err != nil {
			return failed(errInternal, err)
		}
		size := st.Size()
		if remux {
			budget = remuxBudget(size, s.cfg.VideoFixed, ceiling)
		} else if seconds > s.cfg.MaxVideoSecs {
			return failed(errBadMedia, fmt.Errorf("%.0f s of video to re-encode, at most %.0f s", seconds, s.cfg.MaxVideoSecs))
		}
		run := func(copying bool, budget time.Duration) error {
			bctx, cancel := context.WithTimeout(ctx, budget)
			defer cancel()
			var err error
			if copying {
				err = s.remux(bctx, orig, dst, size, seconds)
			} else {
				err = s.transcode(bctx, demuxer, orig, dst, seconds, s.cfg.VideoWidth)
			}
			if err != nil && bctx.Err() != nil && ctx.Err() == nil {
				return failed(errTimeout, fmt.Errorf("video (copy %v) over its %v budget", copying, budget))
			}
			return err
		}
		// An HEVC source wider than the preview is encoded twice: a 720p mp4 first, listed ready at once so it can play,
		// then the full one, which is best-effort once the 720p stands.
		previewed := false
		var previewVideo VideoMeta
		if !remux && isHEVC(p) && w > s.cfg.PreviewWidth {
			if v, err := s.encodePreview(ctx, job.id, demuxer, orig, seconds, transcodeBudget(seconds, s.cfg.VideoRate, s.cfg.VideoFixed, ceiling), meta); err != nil {
				log.Printf("720p encode failed, encoding the full size alone: %v", err)
			} else {
				previewed, previewVideo = true, v
				if left, ok := stageTimeLeft(ctx, s.cfg.VideoFixed); ok {
					budget = min(budget, left)
				} else {
					return s.keepPreview(dst, meta, previewVideo, errors.New("no time left for the full encode"))
				}
			}
		}
		err = run(remux, budget)
		if err != nil && remux && codeOf(err) != errTimeout && ctx.Err() == nil && seconds <= s.cfg.MaxVideoSecs {
			// A copy ffmpeg could not finish may still encode, when the clip is within the encode cap and the stage
			// has the time left for it.
			if left, ok := stageTimeLeft(ctx, s.cfg.VideoFixed); ok {
				log.Printf("remux failed, encoding instead: %v", err)
				err = run(false, min(transcodeBudget(seconds, s.cfg.VideoRate, s.cfg.VideoFixed, ceiling), left))
				remux = false
			}
		}
		if err == nil {
			err = s.checkVideoOutput(ctx, dst, remux, size, seconds, meta)
		}
		if previewed {
			// The 720p stands whatever the full encode did: a failure keeps it, a success replaces it.
			if err != nil {
				return s.keepPreview(dst, meta, previewVideo, err)
			}
			return os.Remove(s.dir("out", "m", "720.mp4"))
		}
		return err
	})
}

// checkVideoOutput checks the finished mp4, records its size in meta and takes the thumbnail.
func (s *Server) checkVideoOutput(ctx context.Context, dst string, copied bool, size int64, seconds float64, meta *metaJSON) error {
	if err := checkFaststart(dst); err != nil {
		return err
	}
	if copied {
		if err := checkCopySize(dst, size); err != nil {
			return err
		}
	}
	out, err := s.probe(ctx, "mov", dst)
	if err != nil {
		return err
	}
	ow, oh, codec, ok := out.video()
	if !ok || codec != "h264" || !strings.Contains(out.Format.FormatName, "mp4") {
		return failed(errOutputInvalid, fmt.Errorf("video produced %q in %q", codec, out.Format.FormatName))
	}
	if copied && out.seconds() >= seconds+copySlackSeconds-1 {
		return failed(errOutputInvalid, fmt.Errorf("copy ran to the %d s slack: %.0f s from %.0f s", copySlackSeconds, out.seconds(), seconds))
	}
	meta.Video = &VideoMeta{W: ow, H: oh, DurationMs: int(out.seconds() * 1000)}
	return s.videoThumb(ctx, dst, out.seconds())
}

func isHEVC(p probe) bool {
	v, ok := p.first("video")
	return ok && v.CodecName == "hevc"
}

// previewThumb is where the 720p's thumbnail waits while the full encode may overwrite t.webp.
func (s *Server) previewThumb() string { return s.dir("scratch", "t720.webp") }

// encodePreview writes out/m/720.mp4, its thumbnail and a meta.json, checks all three the way the finished job's
// outputs are checked, and lists them ready with a manifest of their own. On any failure nothing is left behind.
func (s *Server) encodePreview(ctx context.Context, jobID, demuxer, orig string, seconds float64, budget time.Duration, meta *metaJSON) (VideoMeta, error) {
	mp4 := s.dir("out", "m", "720.mp4")
	cleanup := func() {
		for _, p := range []string{mp4, s.dir("out", "t.webp"), s.dir("out", "meta.json"), s.previewThumb()} {
			os.Remove(p)
		}
	}
	bctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	if err := s.transcode(bctx, demuxer, orig, mp4, seconds, s.cfg.PreviewWidth); err != nil {
		cleanup()
		return VideoMeta{}, err
	}
	if err := checkFaststart(mp4); err != nil {
		cleanup()
		return VideoMeta{}, err
	}
	out, err := s.probe(ctx, "mov", mp4)
	if err != nil {
		cleanup()
		return VideoMeta{}, err
	}
	ow, oh, codec, ok := out.video()
	if !ok || codec != "h264" || !strings.Contains(out.Format.FormatName, "mp4") {
		cleanup()
		return VideoMeta{}, failed(errOutputInvalid, fmt.Errorf("720p produced %q in %q", codec, out.Format.FormatName))
	}
	video := VideoMeta{W: ow, H: oh, DurationMs: int(out.seconds() * 1000)}
	if err := s.videoThumb(ctx, mp4, out.seconds()); err != nil {
		cleanup()
		return VideoMeta{}, err
	}
	m := *meta
	m.Video = &video
	if err := writeJSONFile(s.dir("out", "meta.json"), m); err != nil {
		cleanup()
		return VideoMeta{}, failed(errInternal, err)
	}
	if err := copyFile(s.previewThumb(), s.dir("out", "t.webp")); err != nil {
		cleanup()
		return VideoMeta{}, failed(errInternal, err)
	}
	var files []OutFile
	for _, rel := range []string{"m/720.mp4", "t.webp", "meta.json"} {
		p := filepath.Join(s.dir("out"), filepath.FromSlash(rel))
		info, err := os.Stat(p)
		if err != nil {
			cleanup()
			return VideoMeta{}, failed(errInternal, err)
		}
		typ := "application/json"
		if rel != "meta.json" {
			if typ, _, _, err = checkFile(p, rel, info.Size(), s.cfg.Widths); err != nil {
				cleanup()
				return VideoMeta{}, failed(errOutputInvalid, err)
			}
		}
		sum, err := fileSHA256(p)
		if err != nil {
			cleanup()
			return VideoMeta{}, failed(errInternal, err)
		}
		files = append(files, OutFile{Path: rel, Size: info.Size(), SHA256: sum, Type: typ})
	}
	s.publishPreview(files, &Manifest{V: 1, JobID: jobID, Kind: kindVideo, Groups: map[string]GroupResult{groupMedia: {OK: true}}, Files: files})
	return video, nil
}

// keepPreview ends a job whose full encode did not finish: the 720p, its thumbnail and its meta.json are the outputs.
func (s *Server) keepPreview(full string, meta *metaJSON, video VideoMeta, cause error) error {
	log.Printf("full encode after the 720p did not finish, keeping the 720p: %v", cause)
	os.Remove(full)
	meta.Video = &video
	if err := copyFile(s.dir("out", "t.webp"), s.previewThumb()); err != nil {
		return failed(errInternal, err)
	}
	return nil
}

// idrProbeBudget bounds the one-packet read that decides whether a copy starts on an IDR picture.
const idrProbeBudget = 20 * time.Second

// startsWithIDR reports whether the first access unit of the first video stream holds an IDR slice. ffmpeg writes
// that one unit as Annex B on stdout; the container's own index is never trusted for it.
func (s *Server) startsWithIDR(ctx context.Context, in string) (bool, error) {
	pctx, cancel := context.WithTimeout(ctx, idrProbeBudget)
	defer cancel()
	out, err := s.tool(pctx, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
		"-protocol_whitelist", "file", "-f", "mov", "-i", in, "-map", "0:v:0", "-c", "copy",
		"-bsf:v", "h264_mp4toannexb", "-frames:v", "1", "-f", "h264", "pipe:1")
	if err != nil {
		return false, convertErr(err)
	}
	return firstSliceIsIDR(out), nil
}

// stageTimeLeft is what remains of the stage's timeout after keeping `reserve` for the probes and the thumbnail that
// follow; ok is false when nothing usable is left. A context with no deadline has all the time there is.
func stageTimeLeft(ctx context.Context, reserve time.Duration) (time.Duration, bool) {
	deadline, has := ctx.Deadline()
	if !has {
		return time.Duration(math.MaxInt64), true
	}
	left := time.Until(deadline) - reserve
	return left, left > 0
}

// firstSliceIsIDR reads Annex B NAL units and reports whether the first picture slice (types 1 to 5) is an IDR (5).
func firstSliceIsIDR(annexB []byte) bool {
	for i := 0; i+3 < len(annexB); i++ {
		if annexB[i] == 0 && annexB[i+1] == 0 && annexB[i+2] == 1 {
			switch t := annexB[i+3] & 0x1f; {
			case t == 5:
				return true
			case t >= 1 && t <= 4:
				return false
			}
			i += 2
		}
	}
	return false
}

// ffmpeg runs one ffmpeg command, publishing its progress as the video stage's percentage.
func (s *Server) ffmpeg(ctx context.Context, args []string, seconds float64) error {
	_, err := s.run(ctx, cmdSpec{name: "ffmpeg", args: args, env: s.env(), onLine: func(line string) {
		if us, ok := strings.CutPrefix(line, "out_time_us="); ok {
			if v, err := strconv.ParseFloat(us, 64); err == nil && seconds > 0 {
				s.set("video", 5+int(90*min(1, v/1e6/seconds)))
			}
		}
	}})
	return convertErr(err)
}

// remuxArgs copies the first video and audio streams into a faststart mp4 without decoding them, stripping SEI
// units (free-form user data) from the video, and stops at the input's size and the probed length plus a slack,
// whatever the container claims.
func remuxArgs(in, dst string, size int64, seconds float64) []string {
	return []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-protocol_whitelist", "file", "-f", "mov", "-i", in,
		"-t", strconv.FormatFloat(seconds+copySlackSeconds, 'f', -1, 64),
		"-fs", strconv.FormatInt(copyLimitBytes(size), 10),
		"-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1",
		"-c", "copy", "-bsf:v", "filter_units=remove_types=6",
		"-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dst,
	}
}

func (s *Server) remux(ctx context.Context, in, dst string, size int64, seconds float64) error {
	return s.ffmpeg(ctx, remuxArgs(in, dst, size, seconds), seconds)
}

// transcode bounds the output at MaxVideoSecs with -t, whatever the input's header claims.
func (s *Server) transcode(ctx context.Context, demuxer, in, dst string, seconds float64, width int) error {
	return s.ffmpeg(ctx, []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-protocol_whitelist", "file", "-f", demuxer, "-i", in,
		"-t", strconv.FormatFloat(s.cfg.MaxVideoSecs, 'f', -1, 64),
		"-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1",
		"-vf", fmt.Sprintf("scale=w='min(%d,trunc(iw/2)*2)':h=-2,format=yuv420p", width),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high",
		"-c:a", "aac", "-b:a", "128k", "-ac", "2",
		"-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dst,
	}, seconds)
}

func (s *Server) videoThumb(ctx context.Context, mp4 string, seconds float64) error {
	png := s.dir("scratch", "t.png")
	at := strconv.FormatFloat(min(1, seconds/2), 'f', 3, 64)
	if _, err := s.tool(ctx, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-protocol_whitelist", "file", "-f", "mov", "-ss", at, "-i", mp4, "-frames:v", "1", "-vf", "scale=w='min(480,iw)':h=-2", png); err != nil {
		return convertErr(err)
	}
	_, err := s.tool(ctx, "vips", "copy", png, s.dir("out", "t.webp")+"[Q=80]")
	return convertErr(err)
}

// imageJob turns a HEIC into a 1920 JPEG (metadata stripped, orientation applied) and a 480 thumbnail.
func (s *Server) imageJob(job jobInfo, meta *metaJSON) error {
	var an Analysis
	if err := s.stage("inspect", 2, func(ctx context.Context) error { return s.inspect(ctx, job, &an) }); err != nil {
		return err
	}
	orig := inputPath(s.cfg, job.ext)
	dir := s.dir("out", "i")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return failed(errInternal, err)
	}
	return s.stage("heic", 10, func(ctx context.Context) error {
		var px [2]int64
		for i, field := range []string{"width", "height"} {
			out, err := s.tool(ctx, "vipsheader", "-f", field, orig)
			if err != nil {
				return convertErr(err)
			}
			px[i], _ = strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
		}
		if px[0] < 1 || px[1] < 1 || px[0]*px[1] > s.cfg.MaxImagePx {
			return failed(errBadMedia, fmt.Errorf("image is %d x %d", px[0], px[1]))
		}
		jpg := filepath.Join(dir, "1920.jpg")
		for _, o := range [][]string{
			{jpg + "[Q=85,keep=none]", "1920"},
			{s.dir("out", "t.webp") + "[Q=80,keep=none]", "480"},
		} {
			if _, err := s.tool(ctx, "vips", "thumbnail", orig, o[0], o[1], "--height", "1000000", "--size", "down"); err != nil {
				return convertErr(err)
			}
		}
		f, err := os.Open(jpg)
		if err != nil {
			return failed(errInternal, err)
		}
		defer f.Close()
		b, _ := head(f, 64<<10)
		w, h, err := jpegSize(b)
		if err != nil {
			return failed(errOutputInvalid, err)
		}
		meta.Image = &ImageMeta{W: w, H: h}
		return nil
	})
}
