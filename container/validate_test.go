package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"slices"
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

func itoa(n int) string { return strconv.Itoa(n) }

func deckWant(n int) expectation {
	return expectation{kind: kindDeck, pages: n, widths: defaultWidths}
}

// goodDeckOut writes a valid output tree for a deck of n pages at the given widths.
func goodDeckOut(t *testing.T, n int, widths []int) string {
	t.Helper()
	dir := t.TempDir()
	pages := []PageDim{}
	for p := 1; p <= n; p++ {
		for _, w := range widths {
			put(t, dir, "s/"+itoa(p)+"/"+itoa(w)+".webp", fakeWebP(w, w*9/16))
		}
		pages = append(pages, PageDim{N: p, W: widths[0], H: widths[0] * 9 / 16})
	}
	put(t, dir, "doc.pdf", fakePDF)
	put(t, dir, "t.webp", fakeWebP(480, 270))
	put(t, dir, "slides.json", mustJSON(t, slidesJSON{V: 1, Widths: widths, Pages: pages}))
	put(t, dir, "notes.json", mustJSON(t, notesJSON{V: 1, Notes: []Note{{N: 1, Text: "hello"}}}))
	put(t, dir, "meta.json", mustJSON(t, metaJSON{V: 1, SHA256: hex64, Kind: kindDeck, FontsMissing: []string{}}))
	return dir
}

func paths(files []OutFile) []string {
	var out []string
	for _, f := range files {
		out = append(out, f.Path)
	}
	return out
}

func TestValidateAcceptsAGoodDeck(t *testing.T) {
	dir := goodDeckOut(t, 12, defaultWidths)
	files, groups, err := validateOutputs(dir, deckWant(12))
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
	for _, g := range []string{groupSlides, groupPDF, groupNotes} {
		if !groups[g].OK {
			t.Errorf("group %s: %+v", g, groups[g])
		}
	}
}

func TestValidateAcceptsConfiguredWidths(t *testing.T) {
	widths := []int{2560, 1280, 320}
	dir := goodDeckOut(t, 2, widths)
	files, groups, err := validateOutputs(dir, expectation{kind: kindDeck, pages: 2, widths: widths})
	if err != nil || !groups[groupSlides].OK || len(files) != 2*3+5 {
		t.Fatalf("%v %+v %d files", err, groups, len(files))
	}
	if _, groups, _ := validateOutputs(dir, deckWant(2)); groups[groupSlides].OK {
		t.Fatal("images at other widths passed for the default widths")
	}
}

// A job is invalid as a whole for these: they say the output tree itself cannot be trusted.
func TestValidateWholeJobRefusals(t *testing.T) {
	cases := map[string]func(t *testing.T, dir string){
		"CONV-04 outputs unknown file": func(t *testing.T, dir string) { put(t, dir, "extra.txt", []byte("x")) },
		"CONV-04 outputs symlink": func(t *testing.T, dir string) {
			if err := os.Symlink("/etc/passwd", filepath.Join(dir, "evil.json")); err != nil {
				t.Fatal(err)
			}
		},
		"CONV-04 outputs meta missing": func(t *testing.T, dir string) { os.Remove(filepath.Join(dir, "meta.json")) },
		"CONV-04 outputs meta malformed": func(t *testing.T, dir string) {
			put(t, dir, "meta.json", []byte(`{"v":1,`))
		},
		"CONV-04 outputs meta kind": func(t *testing.T, dir string) {
			put(t, dir, "meta.json", mustJSON(t, metaJSON{V: 1, SHA256: hex64, Kind: kindVideo, FontsMissing: []string{}}))
		},
		"CONV-04 outputs meta sha": func(t *testing.T, dir string) {
			put(t, dir, "meta.json", mustJSON(t, metaJSON{V: 1, SHA256: "short", Kind: kindDeck, FontsMissing: []string{}}))
		},
		"CONV-04 outputs meta unknown key": func(t *testing.T, dir string) {
			put(t, dir, "meta.json", []byte(`{"v":1,"sha256":"`+hex64+`","kind":"deck","fontsMissing":[],"extra":1}`))
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			dir := goodDeckOut(t, 2, defaultWidths)
			mutate(t, dir)
			if _, _, err := validateOutputs(dir, deckWant(2)); !errors.Is(err, errInvalid) {
				t.Fatalf("want an invalid-output error, got %v", err)
			}
		})
	}
}

func TestValidateEveryGroupFailingFailsTheJob(t *testing.T) {
	dir := goodDeckOut(t, 1, defaultWidths)
	put(t, dir, "doc.pdf", []byte("<html>"))
	put(t, dir, "notes.json", []byte("{}"))
	put(t, dir, "s/1/480.webp", []byte("not a webp"))
	if _, _, err := validateOutputs(dir, deckWant(1)); !errors.Is(err, errInvalid) {
		t.Fatalf("got %v", err)
	}
}

// One failing group is reported and withheld; the others are published untouched.
func TestValidateGroupFailureLeavesTheOthersPublished(t *testing.T) {
	cases := map[string]struct {
		group  string
		mutate func(t *testing.T, dir string)
	}{
		"CONV-04 outputs pdf javascript": {groupPDF, func(t *testing.T, dir string) {
			put(t, dir, "doc.pdf", append(append([]byte{}, fakePDF...), "<< /S /JavaScript /JS (x) >>"...))
		}},
		"CONV-04 outputs pdf launch": {groupPDF, func(t *testing.T, dir string) {
			put(t, dir, "doc.pdf", append(append([]byte{}, fakePDF...), "/Launch"...))
		}},
		"CONV-04 outputs pdf magic":   {groupPDF, func(t *testing.T, dir string) { put(t, dir, "doc.pdf", []byte("<html>not a pdf")) }},
		"CONV-04 outputs pdf missing": {groupPDF, func(t *testing.T, dir string) { os.Remove(filepath.Join(dir, "doc.pdf")) }},
		"CONV-04 outputs webp magic": {groupSlides, func(t *testing.T, dir string) {
			put(t, dir, "s/1/480.webp", []byte("GIF89a not a webp, padded to length........................................"))
		}},
		"CONV-04 outputs webp width": {groupSlides, func(t *testing.T, dir string) { put(t, dir, "s/1/1920.webp", fakeWebP(1000, 500)) }},
		"CONV-04 outputs webp riff": {groupSlides, func(t *testing.T, dir string) {
			b := fakeWebP(480, 270)
			binary.LittleEndian.PutUint32(b[4:], 9999)
			put(t, dir, "s/1/480.webp", b)
		}},
		"CONV-04 outputs thumbnail too wide": {groupSlides, func(t *testing.T, dir string) { put(t, dir, "t.webp", fakeWebP(1920, 1080)) }},
		"CONV-04 outputs missing width":      {groupSlides, func(t *testing.T, dir string) { os.Remove(filepath.Join(dir, "s", "2", "1920.webp")) }},
		"CONV-04 outputs extra page":         {groupSlides, func(t *testing.T, dir string) { put(t, dir, "s/3/480.webp", fakeWebP(480, 270)) }},
		"CONV-04 outputs slides notes key": {groupSlides, func(t *testing.T, dir string) {
			put(t, dir, "slides.json", []byte(`{"v":1,"widths":[3840,1920,480],"pages":[{"n":1,"w":3840,"h":2160},{"n":2,"w":3840,"h":2160}],"motion":false,"media":false,"notes":[{"n":1,"text":"leak"}]}`))
		}},
		"CONV-04 outputs slides dims": {groupSlides, func(t *testing.T, dir string) {
			put(t, dir, "slides.json", []byte(`{"v":1,"widths":[3840,1920,480],"pages":[{"n":1,"w":3840,"h":999},{"n":2,"w":3840,"h":2160}],"motion":false,"media":false}`))
		}},
		"CONV-04 outputs slides widths": {groupSlides, func(t *testing.T, dir string) {
			put(t, dir, "slides.json", []byte(`{"v":1,"widths":[3840,480],"pages":[{"n":1,"w":3840,"h":2160},{"n":2,"w":3840,"h":2160}],"motion":false,"media":false}`))
		}},
		"CONV-04 outputs slides malformed": {groupSlides, func(t *testing.T, dir string) { put(t, dir, "slides.json", []byte("{")) }},
		"CONV-04 outputs notes too long": {groupNotes, func(t *testing.T, dir string) {
			put(t, dir, "notes.json", mustJSON(t, notesJSON{V: 1, Notes: []Note{{N: 1, Text: strings.Repeat("x", 4001)}}}))
		}},
		"CONV-04 outputs notes page out of range": {groupNotes, func(t *testing.T, dir string) {
			put(t, dir, "notes.json", mustJSON(t, notesJSON{V: 1, Notes: []Note{{N: 3, Text: "x"}}}))
		}},
		"CONV-04 outputs notes order": {groupNotes, func(t *testing.T, dir string) {
			put(t, dir, "notes.json", mustJSON(t, notesJSON{V: 1, Notes: []Note{{N: 2, Text: "b"}, {N: 1, Text: "a"}}}))
		}},
		"CONV-04 outputs notes malformed": {groupNotes, func(t *testing.T, dir string) { put(t, dir, "notes.json", []byte("[")) }},
		"CONV-04 outputs notes missing":   {groupNotes, func(t *testing.T, dir string) { os.Remove(filepath.Join(dir, "notes.json")) }},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			dir := goodDeckOut(t, 2, defaultWidths)
			c.mutate(t, dir)
			files, groups, err := validateOutputs(dir, deckWant(2))
			if err != nil {
				t.Fatalf("a single failing group must not fail the job: %v", err)
			}
			if groups[c.group].OK || groups[c.group].Error != errOutputInvalid {
				t.Errorf("group %s = %+v", c.group, groups[c.group])
			}
			for _, g := range []string{groupSlides, groupPDF, groupNotes} {
				if g != c.group && !groups[g].OK {
					t.Errorf("group %s was dragged down: %+v", g, groups[g])
				}
			}
			got := paths(files)
			if !slices.Contains(got, "meta.json") {
				t.Error("meta.json missing from a partial manifest")
			}
			for _, rel := range got {
				if g, _ := groupOf(rel, kindDeck); g == c.group {
					t.Errorf("%s published from the failed group %s", rel, c.group)
				}
			}
		})
	}
}

func TestValidateVideoAndImage(t *testing.T) {
	want := func(kind string) expectation { return expectation{kind: kind, widths: defaultWidths} }
	vid := t.TempDir()
	put(t, vid, "m/0.mp4", fakeMP4)
	put(t, vid, "t.webp", fakeWebP(480, 270))
	put(t, vid, "meta.json", mustJSON(t, metaJSON{V: 1, SHA256: hex64, Kind: kindVideo, FontsMissing: []string{}}))
	if _, groups, err := validateOutputs(vid, want(kindVideo)); err != nil || !groups[groupMedia].OK {
		t.Fatal(err, groups)
	}
	put(t, vid, "m/0.mp4", []byte("RIFF....AVI LIST"))
	if _, _, err := validateOutputs(vid, want(kindVideo)); !errors.Is(err, errInvalid) {
		t.Fatalf("a non-mp4 passed: %v", err)
	}

	img := t.TempDir()
	put(t, img, "i/1920.jpg", fakeJPEG(1920, 1440))
	put(t, img, "t.webp", fakeWebP(480, 360))
	put(t, img, "meta.json", mustJSON(t, metaJSON{V: 1, SHA256: hex64, Kind: kindImage, FontsMissing: []string{}}))
	if _, groups, err := validateOutputs(img, want(kindImage)); err != nil || !groups[groupImage].OK {
		t.Fatal(err, groups)
	}
	put(t, img, "i/1920.jpg", fakeJPEG(4000, 3000))
	if _, _, err := validateOutputs(img, want(kindImage)); !errors.Is(err, errInvalid) {
		t.Fatalf("an oversized jpeg passed: %v", err)
	}
	put(t, img, "i/1920.jpg", fakeJPEG(1920, 1440)[:30])
	if _, _, err := validateOutputs(img, want(kindImage)); !errors.Is(err, errInvalid) {
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
