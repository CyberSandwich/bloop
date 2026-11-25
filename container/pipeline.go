package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// jobError carries the status code a failed job reports. The wrapped error goes to the log only.
type jobError struct {
	code string
	err  error
}

func (e *jobError) Error() string { return e.code + ": " + e.err.Error() }
func (e *jobError) Unwrap() error { return e.err }

func failed(code string, err error) error { return &jobError{code: code, err: err} }

func codeOf(err error) string {
	var je *jobError
	if errors.As(err, &je) {
		return je.code
	}
	if errors.Is(err, errInvalid) {
		return errOutputInvalid
	}
	return errInternal
}

// process runs the job to the end and records the result. It is the only writer of terminal state.
func (s *Server) process(job jobInfo) {
	err := s.pipeline(job)
	if err != nil {
		log.Printf("job %s (%s): failed: %v", job.id, job.ext, err)
		s.fail(codeOf(err))
		return
	}
	log.Printf("job %s (%s): done", job.id, job.ext)
}

// stage runs fn under the stage's own timeout.
func (s *Server) stage(name string, pct int, fn func(ctx context.Context) error) error {
	s.set(name, pct)
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.Timeouts[name])
	defer cancel()
	err := fn(ctx)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return failed(errTimeout, fmt.Errorf("stage %s: %w", name, ctx.Err()))
	}
	return err
}

func (s *Server) dir(parts ...string) string {
	return filepath.Join(append([]string{s.cfg.WorkDir}, parts...)...)
}

// env is the complete environment of every tool: nothing is inherited from the server.
func (s *Server) env(extra ...string) []string {
	return append([]string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=" + s.dir("home"),
		"LANG=C.UTF-8",
		"TMPDIR=" + s.cfg.TmpDir,
		"XDG_CACHE_HOME=" + filepath.Join(s.cfg.TmpDir, ".cache"),
	}, extra...)
}

func (s *Server) tool(ctx context.Context, name string, args ...string) ([]byte, error) {
	return s.run(ctx, cmdSpec{name: name, args: args, env: s.env("VIPS_CONCURRENCY=1")})
}

func (s *Server) pipeline(job jobInfo) error {
	for _, d := range []string{"out", "scratch", "home"} {
		if err := os.MkdirAll(s.dir(d), 0o700); err != nil {
			return failed(errInternal, err)
		}
	}
	meta := metaJSON{V: 1, SHA256: job.sha256, Kind: job.kind, FontsMissing: []string{}}
	var err error
	switch job.kind {
	case kindVideo:
		err = s.videoJob(job, &meta)
	case kindImage:
		err = s.imageJob(job, &meta)
	default:
		err = s.documentJob(job, &meta)
	}
	if err != nil {
		return err
	}
	if err := writeJSONFile(s.dir("out", "meta.json"), meta); err != nil {
		return failed(errInternal, err)
	}
	want := expectation{kind: job.kind, widths: s.cfg.Widths}
	if s.pages != nil {
		want.pages = s.pages.Rendered
	}
	files, groups, err := validateOutputs(s.dir("out"), want)
	if err != nil {
		return failed(errOutputInvalid, err)
	}
	s.finish(&Manifest{V: 1, JobID: job.id, Kind: job.kind, Pages: s.pages, Groups: groups, Files: files})
	return nil
}

func writeJSONFile(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o600)
}

func copyFile(dst, src string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// inspect checks the magic bytes and, for zip packages, the unpack limits; for OOXML it also
// reads notes, fonts, motion and media.
func (s *Server) inspect(job jobInfo, an *Analysis) error {
	path := inputPath(s.cfg, job.ext)
	f, err := os.Open(path)
	if err != nil {
		return failed(errInternal, err)
	}
	head := make([]byte, 4096)
	n, _ := io.ReadFull(f, head)
	f.Close()
	if !magicOK(job.ext, head[:n]) {
		return failed(errBadMagic, fmt.Errorf("%s does not look like a .%s", job.id, job.ext))
	}
	if !bytes.HasPrefix(head[:n], magicZip) {
		return nil
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		return failed(errBadArchive, err)
	}
	defer zr.Close()
	if err := verifyArchive(&zr.Reader, s.cfg.Limits); err != nil {
		if errors.Is(err, errBombSize) || strings.Contains(err.Error(), "too many entries") {
			return failed(errBomb, err)
		}
		return failed(errBadArchive, err)
	}
	if isOOXML(job.ext) {
		*an = analyzeOOXML(newPkg(&zr.Reader))
	}
	return nil
}

func isOOXML(ext string) bool {
	switch ext {
	case "pptx", "ppsx", "docx", "xlsx":
		return true
	}
	return false
}

// needsPPTX: formats whose notes, fonts and motion we read from a pptx LibreOffice writes for us.
func needsPPTX(ext string) bool {
	switch ext {
	case "ppt", "pps", "odp":
		return true
	}
	return false
}

func (s *Server) installedFonts(ctx context.Context) map[string]bool {
	out, err := s.tool(ctx, "fc-list", ":", "family")
	if err != nil {
		log.Printf("fc-list: %v", err)
		return map[string]bool{}
	}
	return parseFcList(out)
}

func (s *Server) documentJob(job jobInfo, meta *metaJSON) error {
	var an Analysis
	if err := s.stage("inspect", 2, func(ctx context.Context) error { return s.inspect(job, &an) }); err != nil {
		return err
	}
	orig := inputPath(s.cfg, job.ext)
	pdfPath := s.dir("out", "doc.pdf")
	if err := s.stage("convert", 5, func(ctx context.Context) error {
		if job.kind == kindPDF {
			_, err := s.tool(ctx, "pdftocairo", "-pdf", orig, pdfPath)
			return convertErr(err)
		}
		return s.soffice(ctx, orig, "pdf", pdfPath)
	}); err != nil {
		return err
	}
	if needsPPTX(job.ext) {
		pptxPath := s.dir("scratch", "notes.pptx")
		err := s.stage("convert", 25, func(ctx context.Context) error {
			if err := s.soffice(ctx, orig, "pptx", pptxPath); err != nil {
				return err
			}
			zr, err := zip.OpenReader(pptxPath)
			if err != nil {
				return failed(errConvertFailed, err)
			}
			defer zr.Close()
			an = analyzeOOXML(newPkg(&zr.Reader))
			return nil
		})
		if err != nil {
			return err
		}
	}
	if len(an.Fonts) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), s.cfg.Timeouts["inspect"])
		meta.FontsMissing = missingFonts(an.Fonts, s.installedFonts(ctx))
		cancel()
	}
	var pages []PageDim
	if err := s.stage("rasterize", 40, func(ctx context.Context) error {
		var err error
		pages, err = s.rasterize(ctx, pdfPath)
		return err
	}); err != nil {
		return err
	}
	notes := an.Notes
	if notes == nil {
		notes = []Note{}
	}
	for name, v := range map[string]any{
		"slides.json": slidesJSON{V: 1, Widths: s.cfg.Widths, Pages: pages, Motion: an.Motion, Media: an.Media},
		"notes.json":  notesJSON{V: 1, Notes: notes},
	} {
		if err := writeJSONFile(s.dir("out", name), v); err != nil {
			return failed(errInternal, err)
		}
	}
	return nil
}

func convertErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return err
	}
	return failed(errConvertFailed, err)
}

// soffice converts one file with a fresh profile whose macro security is locked down first.
// It never runs without the registry: a missing file fails the job.
func (s *Server) soffice(ctx context.Context, in, format, dst string) error {
	profile, err := os.MkdirTemp(s.dir("scratch"), "lo-")
	if err != nil {
		return failed(errInternal, err)
	}
	if err := os.MkdirAll(filepath.Join(profile, "user"), 0o700); err != nil {
		return failed(errInternal, err)
	}
	if err := copyFile(filepath.Join(profile, "user", "registrymodifications.xcu"), s.cfg.LORegistry); err != nil {
		return failed(errInternal, fmt.Errorf("macro security registry: %w", err))
	}
	outDir, err := os.MkdirTemp(s.dir("scratch"), "lo-out-")
	if err != nil {
		return failed(errInternal, err)
	}
	_, err = s.run(ctx, cmdSpec{
		name: "soffice",
		args: []string{
			"--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo", "--nofirststartwizard",
			"-env:UserInstallation=file://" + profile,
			"--convert-to", format, "--outdir", outDir, in,
		},
		env: s.env("SAL_USE_VCLPLUGIN=svp"),
	})
	if err != nil {
		return convertErr(err)
	}
	produced := filepath.Join(outDir, strings.TrimSuffix(filepath.Base(in), filepath.Ext(in))+"."+format)
	if err := os.Rename(produced, dst); err != nil {
		return failed(errConvertFailed, fmt.Errorf("soffice produced no .%s: %w", format, err))
	}
	return nil
}

var (
	rePages    = regexp.MustCompile(`(?m)^Pages:\s+(\d+)`)
	rePageSize = regexp.MustCompile(`(?m)^Page\s+(\d+)\s+size:\s+([0-9.]+) x ([0-9.]+) pts`)
)

const (
	minAspect = 0.25 // width over height
	maxAspect = 8.0
)

// pdfPageCount and pageSizes read pdfinfo output.
func pdfPageCount(out []byte) int {
	m := rePages.FindSubmatch(out)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(string(m[1]))
	return n
}

func checkPageSizes(out []byte, pages int) error {
	seen := 0
	for _, m := range rePageSize.FindAllSubmatch(out, -1) {
		w, _ := strconv.ParseFloat(string(m[2]), 64)
		h, _ := strconv.ParseFloat(string(m[3]), 64)
		if w <= 0 || h <= 0 || w/h < minAspect || w/h > maxAspect {
			return failed(errBadPageSize, fmt.Errorf("page %s is %s x %s pts", m[1], m[2], m[3]))
		}
		seen++
	}
	if seen != pages {
		return failed(errConvertFailed, fmt.Errorf("pdfinfo listed %d page sizes for %d pages", seen, pages))
	}
	return nil
}

// rasterize renders the first MaxPages pages at every configured width, as WebP, and returns each
// page's size at the widest rendition. Page 1 is rendered alone first and published at once; the
// manifest records the true page count when the document is longer.
func (s *Server) rasterize(ctx context.Context, pdf string) ([]PageDim, error) {
	info, err := s.tool(ctx, "pdfinfo", pdf)
	if err != nil {
		return nil, convertErr(err)
	}
	total := pdfPageCount(info)
	if total < 1 {
		return nil, failed(errConvertFailed, errors.New("no pages"))
	}
	pages := min(total, s.cfg.MaxPages)
	s.pages = &PagesInfo{Total: total, Rendered: pages}
	sizes, err := s.tool(ctx, "pdfinfo", "-f", "1", "-l", strconv.Itoa(pages), pdf)
	if err != nil {
		return nil, convertErr(err)
	}
	if err := checkPageSizes(sizes, pages); err != nil {
		return nil, err
	}
	s.setPages(0, pages)
	if err := s.renderPage(ctx, pdf, 1); err != nil {
		return nil, err
	}
	if err := s.publishFirstPage(); err != nil {
		return nil, err
	}
	s.setPages(1, pages)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan int)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var first error
	done := 1
	for range min(s.cfg.Workers, pages-1) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := range jobs {
				if ctx.Err() != nil {
					continue
				}
				err := s.renderPage(ctx, pdf, n)
				mu.Lock()
				if err != nil && first == nil {
					first = err
					cancel()
				}
				done++
				d := done
				mu.Unlock()
				s.set("rasterize", 40+55*d/pages)
				s.setPages(d, pages)
			}
		}()
	}
	for n := 2; n <= pages; n++ {
		jobs <- n
	}
	close(jobs)
	wg.Wait()
	if first != nil {
		return nil, first
	}
	dims := make([]PageDim, pages)
	for n := 1; n <= pages; n++ {
		f, err := os.Open(s.dir("out", "s", strconv.Itoa(n), strconv.Itoa(s.cfg.Widths[0])+".webp"))
		if err != nil {
			return nil, failed(errInternal, err)
		}
		hdr, _ := head(f, 64)
		f.Close()
		w, h, err := webpSize(hdr)
		if err != nil {
			return nil, failed(errOutputInvalid, err)
		}
		dims[n-1] = PageDim{N: n, W: w, H: h}
	}
	return dims, nil
}

// publishFirstPage makes page 1 and the thumbnail fetchable while the other pages render. A file
// that fails its check is not published; the final validation then withholds the whole group.
func (s *Server) publishFirstPage() error {
	widths := s.cfg.Widths
	out := s.dir("out")
	if err := copyFile(filepath.Join(out, "t.webp"), filepath.Join(out, "s", "1", strconv.Itoa(widths[len(widths)-1])+".webp")); err != nil {
		return failed(errInternal, err)
	}
	rels := []string{"t.webp"}
	for _, w := range widths {
		rels = append(rels, fmt.Sprintf("s/1/%d.webp", w))
	}
	var files []OutFile
	for _, rel := range rels {
		p := filepath.Join(out, filepath.FromSlash(rel))
		info, err := os.Stat(p)
		if err != nil {
			return failed(errInternal, err)
		}
		typ, _, _, err := checkFile(p, rel, info.Size(), widths)
		if err != nil {
			log.Printf("first page %s: %v", rel, err)
			return nil
		}
		sum, err := fileSHA256(p)
		if err != nil {
			return failed(errInternal, err)
		}
		files = append(files, OutFile{Path: rel, Size: info.Size(), SHA256: sum, Type: typ})
	}
	s.publish(files)
	return nil
}

func (s *Server) renderPage(ctx context.Context, pdf string, n int) error {
	dir := s.dir("out", "s", strconv.Itoa(n))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return failed(errInternal, err)
	}
	widest := strconv.Itoa(s.cfg.Widths[0])
	base := s.dir("scratch", "p"+strconv.Itoa(n))
	png := base + ".png"
	defer os.Remove(png)
	if _, err := s.tool(ctx, "pdftoppm", "-f", strconv.Itoa(n), "-l", strconv.Itoa(n),
		"-scale-to-x", widest, "-scale-to-y", "-1", "-png", "-singlefile", pdf, base); err != nil {
		return convertErr(err)
	}
	if _, err := s.tool(ctx, "vips", "copy", png, filepath.Join(dir, widest+".webp")+"[Q=80]"); err != nil {
		return convertErr(err)
	}
	for _, w := range s.cfg.Widths[1:] {
		out := filepath.Join(dir, strconv.Itoa(w)+".webp") + "[Q=80]"
		if _, err := s.tool(ctx, "vips", "thumbnail", png, out, strconv.Itoa(w), "--height", "1000000"); err != nil {
			return convertErr(err)
		}
	}
	return nil
}

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

func (s *Server) probe(ctx context.Context, path string) (probe, error) {
	out, err := s.tool(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file", "-print_format", "json",
		"-show_format", "-show_streams", path)
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
		p, err := s.probe(ctx, orig)
		if err != nil {
			return err
		}
		w, h, _, ok := p.video()
		seconds = p.seconds()
		if !ok || w > maxVideoDim || h > maxVideoDim || seconds <= 0 || seconds > s.cfg.MaxVideoSecs {
			return failed(errBadMedia, fmt.Errorf("video %dx%d, %.0f s, stream %v", w, h, seconds, ok))
		}
		if err := s.transcode(ctx, orig, dst, seconds); err != nil {
			return err
		}
		out, err := s.probe(ctx, dst)
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

func (s *Server) transcode(ctx context.Context, in, dst string, seconds float64) error {
	args := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-protocol_whitelist", "file", "-i", in,
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
