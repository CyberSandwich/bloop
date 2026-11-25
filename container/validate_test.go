package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func put(t *testing.T, dir, rel string, b []byte) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

const hex64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// goodDeckOut writes a valid output tree for a deck of n pages.
func goodDeckOut(t *testing.T, n int) string {
	t.Helper()
	dir := t.TempDir()
	pages := []PageDim{}
	for p := 1; p <= n; p++ {
		for _, w := range pageWidths {
			put(t, dir, "s/"+itoa(p)+"/"+itoa(w)+".webp", fakeWebP(w, w*9/16))
		}
		pages = append(pages, PageDim{N: p, W: 3840, H: 2160})
	}
	put(t, dir, "doc.pdf", fakePDF)
	put(t, dir, "t.webp", fakeWebP(480, 270))
	put(t, dir, "slides.json", mustJSON(t, slidesJSON{V: 1, Pages: pages}))
	put(t, dir, "notes.json", mustJSON(t, notesJSON{V: 1, Notes: []Note{{N: 1, Text: "hello"}}}))
	put(t, dir, "meta.json", mustJSON(t, metaJSON{V: 1, SHA256: hex64, Kind: kindDeck, FontsMissing: []string{}}))
	return dir
}

func itoa(n int) string { return strconv.Itoa(n) }

func TestValidateAcceptsAGoodDeck(t *testing.T) {
	dir := goodDeckOut(t, 12)
	files, err := validateOutputs(dir, expectation{kind: kindDeck, pages: 12})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 12*3+5 {
		t.Fatalf("%d files", len(files))
	}
	for _, f := range files {
		if len(f.SHA256) != 64 || f.Type == "" || f.Size == 0 {
			t.Errorf("incomplete entry %+v", f)
		}
	}
}

func TestValidateRefusals(t *testing.T) {
	cases := map[string]func(t *testing.T, dir string){
		"CONV-04 outputs unknown file": func(t *testing.T, dir string) { put(t, dir, "extra.txt", []byte("x")) },
		"CONV-04 outputs symlink": func(t *testing.T, dir string) {
			if err := os.Symlink("/etc/passwd", filepath.Join(dir, "evil.json")); err != nil {
				t.Fatal(err)
			}
		},
		"CONV-04 outputs pdf javascript": func(t *testing.T, dir string) {
			put(t, dir, "doc.pdf", append(append([]byte{}, fakePDF...), "<< /S /JavaScript /JS (x) >>"...))
		},
		"CONV-04 outputs pdf launch": func(t *testing.T, dir string) {
			put(t, dir, "doc.pdf", append(append([]byte{}, fakePDF...), "/Launch"...))
		},
		"CONV-04 outputs pdf magic": func(t *testing.T, dir string) { put(t, dir, "doc.pdf", []byte("<html>not a pdf")) },
		"CONV-04 outputs webp magic": func(t *testing.T, dir string) {
			put(t, dir, "s/1/480.webp", []byte("GIF89a not a webp, padded to length........................................"))
		},
		"CONV-04 outputs webp width": func(t *testing.T, dir string) { put(t, dir, "s/1/1920.webp", fakeWebP(1000, 500)) },
		"CONV-04 outputs webp riff": func(t *testing.T, dir string) {
			b := fakeWebP(480, 270)
			binary.LittleEndian.PutUint32(b[4:], 9999)
			put(t, dir, "s/1/480.webp", b)
		},
		"CONV-04 outputs thumbnail too wide": func(t *testing.T, dir string) { put(t, dir, "t.webp", fakeWebP(1920, 1080)) },
		"CONV-04 outputs missing width":      func(t *testing.T, dir string) { os.Remove(filepath.Join(dir, "s", "2", "1920.webp")) },
		"CONV-04 outputs missing pdf":        func(t *testing.T, dir string) { os.Remove(filepath.Join(dir, "doc.pdf")) },
		"CONV-04 outputs extra page":         func(t *testing.T, dir string) { put(t, dir, "s/3/480.webp", fakeWebP(480, 270)) },
		"CONV-04 outputs slides notes key": func(t *testing.T, dir string) {
			put(t, dir, "slides.json", []byte(`{"v":1,"pages":[{"n":1,"w":3840,"h":2160},{"n":2,"w":3840,"h":2160}],"motion":false,"media":false,"notes":[{"n":1,"text":"leak"}]}`))
		},
		"CONV-04 outputs slides dims": func(t *testing.T, dir string) {
			put(t, dir, "slides.json", []byte(`{"v":1,"pages":[{"n":1,"w":3840,"h":999},{"n":2,"w":3840,"h":2160}],"motion":false,"media":false}`))
		},
		"CONV-04 outputs notes too long": func(t *testing.T, dir string) {
			put(t, dir, "notes.json", mustJSON(t, notesJSON{V: 1, Notes: []Note{{N: 1, Text: strings.Repeat("x", 4001)}}}))
		},
		"CONV-04 outputs notes page out of range": func(t *testing.T, dir string) {
			put(t, dir, "notes.json", mustJSON(t, notesJSON{V: 1, Notes: []Note{{N: 3, Text: "x"}}}))
		},
		"CONV-04 outputs notes order": func(t *testing.T, dir string) {
			put(t, dir, "notes.json", mustJSON(t, notesJSON{V: 1, Notes: []Note{{N: 2, Text: "b"}, {N: 1, Text: "a"}}}))
		},
		"CONV-04 outputs meta kind": func(t *testing.T, dir string) {
			put(t, dir, "meta.json", mustJSON(t, metaJSON{V: 1, SHA256: hex64, Kind: kindVideo, FontsMissing: []string{}}))
		},
		"CONV-04 outputs meta sha": func(t *testing.T, dir string) {
			put(t, dir, "meta.json", mustJSON(t, metaJSON{V: 1, SHA256: "short", Kind: kindDeck, FontsMissing: []string{}}))
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			dir := goodDeckOut(t, 2)
			mutate(t, dir)
			_, err := validateOutputs(dir, expectation{kind: kindDeck, pages: 2})
			if !errors.Is(err, errInvalid) {
				t.Fatalf("want an invalid-output error, got %v", err)
			}
		})
	}
}

func TestValidateVideoAndImage(t *testing.T) {
	vid := t.TempDir()
	put(t, vid, "m/0.mp4", fakeMP4)
	put(t, vid, "t.webp", fakeWebP(480, 270))
	put(t, vid, "meta.json", mustJSON(t, metaJSON{V: 1, SHA256: hex64, Kind: kindVideo, FontsMissing: []string{}}))
	if _, err := validateOutputs(vid, expectation{kind: kindVideo}); err != nil {
		t.Fatal(err)
	}
	put(t, vid, "m/0.mp4", []byte("RIFF....AVI LIST"))
	if _, err := validateOutputs(vid, expectation{kind: kindVideo}); !errors.Is(err, errInvalid) {
		t.Fatalf("a non-mp4 passed: %v", err)
	}

	img := t.TempDir()
	put(t, img, "i/1920.jpg", fakeJPEG(1920, 1440))
	put(t, img, "t.webp", fakeWebP(480, 360))
	put(t, img, "meta.json", mustJSON(t, metaJSON{V: 1, SHA256: hex64, Kind: kindImage, FontsMissing: []string{}}))
	if _, err := validateOutputs(img, expectation{kind: kindImage}); err != nil {
		t.Fatal(err)
	}
	put(t, img, "i/1920.jpg", fakeJPEG(4000, 3000))
	if _, err := validateOutputs(img, expectation{kind: kindImage}); !errors.Is(err, errInvalid) {
		t.Fatalf("an oversized jpeg passed: %v", err)
	}
	put(t, img, "i/1920.jpg", fakeJPEG(1920, 1440)[:30])
	if _, err := validateOutputs(img, expectation{kind: kindImage}); !errors.Is(err, errInvalid) {
		t.Fatalf("a truncated jpeg passed: %v", err)
	}
}

func TestHasPDFActiveFindsATokenAcrossAChunkBoundary(t *testing.T) {
	// The first read returns 1 MiB plus the overlap; the token starts five bytes before that ends.
	pad := bytes.Repeat([]byte("a"), 1<<20+16-5)
	data := append(append(append([]byte{}, pad...), "/JavaScript"...), pad[:100]...)
	got, err := hasPDFActive(bytes.NewReader(data))
	if err != nil || !got {
		t.Fatalf("token split across chunks: %v %v", got, err)
	}
	if got, _ := hasPDFActive(bytes.NewReader(append(append([]byte{}, pad...), "/JSON, /Js, JavaScript"...))); got {
		t.Fatal("false positive")
	}
}

func TestWebPAndJPEGSizeReaders(t *testing.T) {
	w, h, err := webpSize(fakeWebP(3840, 2160))
	if err != nil || w != 3840 || h != 2160 {
		t.Fatalf("webp %d %d %v", w, h, err)
	}
	w, h, err = jpegSize(fakeJPEG(1920, 1080))
	if err != nil || w != 1920 || h != 1080 {
		t.Fatalf("jpeg %d %d %v", w, h, err)
	}
	// VP8X: canvas size minus one in 24 bits.
	x := make([]byte, 64)
	copy(x, "RIFF")
	copy(x[8:], "WEBPVP8X")
	x[24], x[25], x[26] = 0x7f, 0x07, 0x00 // 1919
	x[27], x[28], x[29] = 0x37, 0x04, 0x00 // 1079
	if w, h, err = webpSize(x); err != nil || w != 1920 || h != 1080 {
		t.Fatalf("vp8x %d %d %v", w, h, err)
	}
	if _, _, err := webpSize([]byte("short")); err == nil {
		t.Fatal("short input accepted")
	}
}
