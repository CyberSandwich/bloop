package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// mkZip builds a deflated zip from name/content pairs.
func mkZip(entries ...[2]string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		w, err := zw.Create(e[0])
		if err != nil {
			panic(err)
		}
		w.Write([]byte(e[1]))
	}
	if err := zw.Close(); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// fakeWebP is a header-only WebP (VP8L) of the given size, padded to look like a file.
func fakeWebP(w, h int) []byte {
	b := make([]byte, 64)
	copy(b[0:], "RIFF")
	copy(b[8:], "WEBPVP8L")
	b[20] = 0x2f
	binary.LittleEndian.PutUint32(b[21:], uint32(w-1)|uint32(h-1)<<14)
	binary.LittleEndian.PutUint32(b[4:], uint32(len(b)-8))
	return b
}

func fakeJPEG(w, h int) []byte {
	b := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10}
	b = append(b, []byte("JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")...)
	b = append(b, 0xFF, 0xC0, 0x00, 0x11, 0x08, byte(h>>8), byte(h), byte(w>>8), byte(w), 0x03)
	b = append(b, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1)
	return append(b, 0xFF, 0xD9)
}

var fakePDF = []byte("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n")

var fakeMP4 = append([]byte{0, 0, 0, 0x18}, []byte("ftypisom\x00\x00\x02\x00isomiso2")...)

// fakeTools stands in for every external tool, writing plausible outputs.
type fakeTools struct {
	mu       sync.Mutex
	calls    []cmdSpec
	pages    int
	pptxOut  []byte        // what soffice writes for --convert-to pptx
	pdfOut   []byte        // what soffice and pdftocairo write for a pdf
	blockOn  string        // a tool that waits for ctx
	failOn   string        // a tool that exits non-zero
	probeIn  string        // ffprobe JSON for the upload
	probeOut string        // ffprobe JSON for the mp4
	delay    time.Duration // added to every call

	failLaterPages bool          // pdftoppm fails for every page after the first
	holdPages      chan struct{} // when set, pdftoppm for any page after the first waits for a receive or close
}

func newFakeTools(pages int) *fakeTools {
	return &fakeTools{
		pages:    pages,
		pdfOut:   fakePDF,
		pptxOut:  mkZip([2]string{"[Content_Types].xml", "<Types/>"}),
		probeIn:  `{"streams":[{"codec_type":"video","codec_name":"hevc","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac"}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"3.000"}}`,
		probeOut: `{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"3.000"}}`,
	}
}

func (f *fakeTools) called(name string) []cmdSpec {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []cmdSpec
	for _, c := range f.calls {
		if c.name == name {
			out = append(out, c)
		}
	}
	return out
}

func after(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func stripOpts(p string) string {
	if i := strings.Index(p, "["); i >= 0 {
		return p[:i]
	}
	return p
}

func (f *fakeTools) run(ctx context.Context, spec cmdSpec) ([]byte, error) {
	f.mu.Lock()
	f.calls = append(f.calls, spec)
	f.mu.Unlock()
	if f.delay > 0 {
		time.Sleep(f.delay)
	}
	if spec.name == f.blockOn {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if spec.name == f.failOn {
		return nil, fmt.Errorf("%s: exit status 1", spec.name)
	}
	a := spec.args
	last := a[len(a)-1]
	write := func(path string, b []byte) error {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		return os.WriteFile(path, b, 0o600)
	}
	switch spec.name {
	case "fc-list":
		return []byte("Carlito\nLiberation Sans\nCaladea\nLiberation Serif,Liberation\n"), nil
	case "soffice":
		format := after(a, "--convert-to")
		base := strings.TrimSuffix(filepath.Base(last), filepath.Ext(last))
		out := filepath.Join(after(a, "--outdir"), base+"."+format)
		if format == "pptx" {
			return nil, write(out, f.pptxOut)
		}
		return nil, write(out, f.pdfOut)
	case "pdftocairo":
		return nil, write(last, f.pdfOut)
	case "pdfinfo":
		if after(a, "-f") != "" {
			var b strings.Builder
			last, _ := strconv.Atoi(after(a, "-l"))
			for n := 1; n <= min(f.pages, last); n++ {
				fmt.Fprintf(&b, "Page %4d size: 960 x 540 pts\n", n)
			}
			return []byte(b.String()), nil
		}
		return []byte(fmt.Sprintf("Title: x\nPages:          %d\n", f.pages)), nil
	case "pdftoppm":
		if f.failLaterPages && after(a, "-f") != "1" {
			return nil, fmt.Errorf("pdftoppm: exit status 1")
		}
		if f.holdPages != nil && after(a, "-f") != "1" {
			select {
			case <-f.holdPages:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return nil, write(last+".png", []byte("png"))
	case "vipsheader":
		if after(a, "-f") == "width" {
			return []byte("4032\n"), nil
		}
		return []byte("3024\n"), nil
	case "vips":
		switch a[0] {
		case "copy":
			out := stripOpts(a[2])
			if w, err := strconv.Atoi(strings.TrimSuffix(filepath.Base(out), ".webp")); err == nil {
				return nil, write(out, fakeWebP(w, w*9/16))
			}
			return nil, write(out, fakeWebP(480, 270))
		case "thumbnail":
			out := stripOpts(a[2])
			w, _ := strconv.Atoi(a[3])
			if strings.HasSuffix(out, ".jpg") {
				return nil, write(out, fakeJPEG(w, w*3/4))
			}
			return nil, write(out, fakeWebP(w, w*9/16))
		}
	case "ffprobe":
		if strings.HasSuffix(last, "m/0.mp4") {
			return []byte(f.probeOut), nil
		}
		return []byte(f.probeIn), nil
	case "ffmpeg":
		if spec.onLine != nil {
			spec.onLine("out_time_us=1500000")
		}
		if strings.HasSuffix(last, ".mp4") {
			return nil, write(last, fakeMP4)
		}
		return nil, write(last, []byte("png"))
	}
	return nil, fmt.Errorf("fake: unexpected tool %s %v", spec.name, a)
}

// testServer returns a server whose work dir, tmp dir and registry live under t.TempDir().
func testServer(t *testing.T, tools *fakeTools) *Server {
	t.Helper()
	root := t.TempDir()
	reg := filepath.Join(root, "lo-registry.xcu")
	if err := os.WriteFile(reg, []byte("<oor:items/>"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := loadConfig(func(k string) string {
		return map[string]string{
			"BLOOP_WORK":        filepath.Join(root, "work"),
			"BLOOP_TMP":         filepath.Join(root, "tmp"),
			"BLOOP_LO_REGISTRY": reg,
			"BLOOP_WORKERS":     "2",
		}[k]
	})
	return newServer(cfg, tools.run)
}

func mustJSON(t testing.TB, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
