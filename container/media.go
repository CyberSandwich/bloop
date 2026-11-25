package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type probe struct {
	Streams []struct {
		CodecType string `json:"codec_type"`
		CodecName string `json:"codec_name"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
	} `json:"streams"`
	Format struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
	} `json:"format"`
}

func (p probe) video() (w, h int, codec string, ok bool) {
	for _, st := range p.Streams {
		if st.CodecType == "video" && st.Width > 0 && st.Height > 0 {
			return st.Width, st.Height, st.CodecName, true
		}
	}
	return 0, 0, "", false
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

// videoJob probes the upload, re-encodes it to H.264/AAC mp4, and takes a thumbnail.
func (s *Server) videoJob(job jobInfo, meta *metaJSON) error {
	var an Analysis
	if err := s.stage("inspect", 2, func(ctx context.Context) error { return s.inspect(job, &an) }); err != nil {
		return err
	}
	orig := inputPath(s.cfg, job.ext)
	dst := s.dir("out", "m", "0.mp4")
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return failed(errInternal, err)
	}
	var seconds float64
	err := s.stage("video", 5, func(ctx context.Context) error {
		demuxer := demuxerFor(job.ext)
		p, err := s.probe(ctx, demuxer, orig)
		if err != nil {
			return err
		}
		w, h, _, ok := p.video()
		seconds = p.seconds()
		if !ok || w > maxVideoDim || h > maxVideoDim || seconds <= 0 || seconds > s.cfg.MaxVideoSecs {
			return failed(errBadMedia, fmt.Errorf("video %dx%d, %.0f s, stream %v", w, h, seconds, ok))
		}
		if err := s.transcode(ctx, demuxer, orig, dst, seconds); err != nil {
			return err
		}
		out, err := s.probe(ctx, "mov", dst)
		if err != nil {
			return err
		}
		ow, oh, codec, ok := out.video()
		if !ok || codec != "h264" || !strings.Contains(out.Format.FormatName, "mp4") {
			return failed(errOutputInvalid, fmt.Errorf("transcode produced %q in %q", codec, out.Format.FormatName))
		}
		meta.Video = &VideoMeta{W: ow, H: oh, DurationMs: int(out.seconds() * 1000)}
		return s.videoThumb(ctx, dst, out.seconds())
	})
	return err
}

// transcode bounds the output at MaxVideoSecs with -t, whatever the input's header claims.
func (s *Server) transcode(ctx context.Context, demuxer, in, dst string, seconds float64) error {
	args := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-protocol_whitelist", "file", "-f", demuxer, "-i", in,
		"-t", strconv.FormatFloat(s.cfg.MaxVideoSecs, 'f', -1, 64),
		"-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1",
		"-vf", "scale=w='min(1920,trunc(iw/2)*2)':h=-2,format=yuv420p",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high",
		"-c:a", "aac", "-b:a", "128k", "-ac", "2",
		"-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dst,
	}
	_, err := s.run(ctx, cmdSpec{name: "ffmpeg", args: args, env: s.env(), onLine: func(line string) {
		if us, ok := strings.CutPrefix(line, "out_time_us="); ok {
			if v, err := strconv.ParseFloat(us, 64); err == nil && seconds > 0 {
				s.set("video", 5+int(90*v/1e6/seconds))
			}
		}
	}})
	return convertErr(err)
}

func (s *Server) videoThumb(ctx context.Context, mp4 string, seconds float64) error {
	png := s.dir("scratch", "t.png")
	at := strconv.FormatFloat(min(1, seconds/2), 'f', 3, 64)
	if _, err := s.tool(ctx, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-ss", at, "-i", mp4, "-frames:v", "1", "-vf", "scale=w='min(480,iw)':h=-2", png); err != nil {
		return convertErr(err)
	}
	_, err := s.tool(ctx, "vips", "copy", png, s.dir("out", "t.webp")+"[Q=80]")
	return convertErr(err)
}

// imageJob turns a HEIC into a 1920 JPEG (metadata stripped, orientation applied) and a 480 thumbnail.
func (s *Server) imageJob(job jobInfo, meta *metaJSON) error {
	var an Analysis
	if err := s.stage("inspect", 2, func(ctx context.Context) error { return s.inspect(job, &an) }); err != nil {
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
