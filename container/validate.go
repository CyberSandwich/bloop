package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"unicode/utf8"
)

// Output sizes in bytes. The Durable Object re-checks these; this is the first line.
const (
	maxWebPBytes = 40 << 20
	maxJPEGBytes = 40 << 20
	maxPDFBytes  = 1 << 30
	maxMP4Bytes  = 4 << 30
	maxJSONBytes = 5 << 20
	maxTotal     = 8 << 30

	jpegWidth  = 1920
	thumbWidth = 480
)

var pageWidths = []int{3840, 1920, 480}

var (
	rePagePath  = regexp.MustCompile(`^s/([1-9][0-9]*)/(3840|1920|480)\.webp$`)
	reVideoPath = regexp.MustCompile(`^m/[0-9]+\.mp4$`)
)

// Banned inside a produced PDF: names that run code or carry a payload. A bare "/JS" is not
// scanned: three bytes turn up by chance in compressed streams, and a JavaScript action always
// also carries "/JavaScript".
var pdfActive = [][]byte{[]byte("/JavaScript"), []byte("/Launch"), []byte("/EmbeddedFile")}

// PageDim is one rendered page at the widest size.
type PageDim struct {
	N int `json:"n"`
	W int `json:"w"`
	H int `json:"h"`
}

type slidesJSON struct {
	V      int       `json:"v"`
	Pages  []PageDim `json:"pages"`
	Motion bool      `json:"motion"`
	Media  bool      `json:"media"`
}

type notesJSON struct {
	V     int    `json:"v"`
	Notes []Note `json:"notes"`
}

type metaJSON struct {
	V            int        `json:"v"`
	SHA256       string     `json:"sha256"`
	Kind         string     `json:"kind"`
	FontsMissing []string   `json:"fontsMissing"`
	Video        *VideoMeta `json:"video,omitempty"`
	Image        *ImageMeta `json:"image,omitempty"`
}

// VideoMeta describes the transcoded mp4.
type VideoMeta struct {
	W          int `json:"w"`
	H          int `json:"h"`
	DurationMs int `json:"durationMs"`
}

// ImageMeta describes the JPEG made from a HEIC.
type ImageMeta struct {
	W int `json:"w"`
	H int `json:"h"`
}

// OutFile is one manifest entry.
type OutFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Type   string `json:"type"`
}

var errInvalid = errors.New("invalid output")

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", errInvalid, fmt.Sprintf(format, a...))
}

// webpSize reads the canvas size from a WebP header (lossy, lossless or extended).
func webpSize(b []byte) (w, h int, err error) {
	if len(b) < 30 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return 0, 0, errors.New("not a webp")
	}
	switch string(b[12:16]) {
	case "VP8 ":
		if b[23] != 0x9d || b[24] != 0x01 || b[25] != 0x2a {
			return 0, 0, errors.New("bad vp8 frame")
		}
		return int(binary.LittleEndian.Uint16(b[26:]) & 0x3fff), int(binary.LittleEndian.Uint16(b[28:]) & 0x3fff), nil
	case "VP8L":
		if b[20] != 0x2f {
			return 0, 0, errors.New("bad vp8l signature")
		}
		bits := binary.LittleEndian.Uint32(b[21:])
		return int(bits&0x3fff) + 1, int((bits>>14)&0x3fff) + 1, nil
	case "VP8X":
		w = int(b[24]) | int(b[25])<<8 | int(b[26])<<16
		h = int(b[27]) | int(b[28])<<8 | int(b[29])<<16
		return w + 1, h + 1, nil
	}
	return 0, 0, errors.New("unknown webp chunk")
}

// jpegSize walks the markers up to the first start-of-frame and returns its size.
func jpegSize(b []byte) (w, h int, err error) {
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 || b[2] != 0xFF {
		return 0, 0, errors.New("not a jpeg")
	}
	i := 2
	for i+9 < len(b) {
		if b[i] != 0xFF {
			return 0, 0, errors.New("bad jpeg marker")
		}
		m := b[i+1]
		if m == 0xFF {
			i++
			continue
		}
		if m >= 0xC0 && m <= 0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC {
			return int(b[i+7])<<8 | int(b[i+8]), int(b[i+5])<<8 | int(b[i+6]), nil
		}
		i += 2 + (int(b[i+2])<<8 | int(b[i+3]))
	}
	return 0, 0, errors.New("no jpeg frame header")
}

// hasPDFActive reports a banned token anywhere in r. It scans in chunks that overlap by the longest token.
func hasPDFActive(r io.Reader) (bool, error) {
	const overlap = 16
	buf := make([]byte, 1<<20+overlap)
	kept := 0
	for {
		n, err := r.Read(buf[kept:])
		window := buf[:kept+n]
		for _, tok := range pdfActive {
			if bytes.Contains(window, tok) {
				return true, nil
			}
		}
		if err == io.EOF {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		kept = min(overlap, len(window))
		copy(buf, window[len(window)-kept:])
	}
}

func head(f *os.File, n int) ([]byte, error) {
	b := make([]byte, n)
	m, err := io.ReadFull(f, b)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return b[:m], nil
}

func tail(f *os.File, size int64, n int64) ([]byte, error) {
	off := max(0, size-n)
	b := make([]byte, size-off)
	_, err := f.ReadAt(b, off)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return b, nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// expectation says what a finished job's output must contain.
type expectation struct {
	kind  string
	pages int // office and pdf kinds: the page count of doc.pdf
}

// validateOutputs walks dir and checks every file by its path: only known names, regular files,
// magic bytes, sizes, dimensions and JSON shape. It returns the manifest entries, sorted by path.
func validateOutputs(dir string, want expectation) ([]OutFile, error) {
	var files []OutFile
	dims := map[string][2]int{}
	var total int64
	seen := map[string]bool{}
	pages := map[int]map[int]bool{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return invalid("%s is not a regular file", rel)
		}
		total += info.Size()
		if total > maxTotal {
			return invalid("outputs exceed %d bytes", int64(maxTotal))
		}
		typ, w, h, err := checkFile(p, rel, info.Size())
		if err != nil {
			return invalid("%s: %v", rel, err)
		}
		if w > 0 {
			dims[rel] = [2]int{w, h}
		}
		if m := rePagePath.FindStringSubmatch(rel); m != nil {
			n, _ := strconv.Atoi(m[1])
			width, _ := strconv.Atoi(m[2])
			if pages[n] == nil {
				pages[n] = map[int]bool{}
			}
			pages[n][width] = true
		}
		seen[rel] = true
		files = append(files, OutFile{Path: rel, Size: info.Size(), Type: typ})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := checkRequired(want, seen, pages); err != nil {
		return nil, err
	}
	if err := checkJSONFiles(dir, want, dims); err != nil {
		return nil, err
	}
	for i := range files {
		sum, err := fileSHA256(filepath.Join(dir, filepath.FromSlash(files[i].Path)))
		if err != nil {
			return nil, err
		}
		files[i].SHA256 = sum
	}
	return files, nil
}

// checkFile validates one output by its relative path and returns its MIME type and, for images, its size.
func checkFile(p, rel string, size int64) (typ string, w, h int, err error) {
	f, err := os.Open(p)
	if err != nil {
		return "", 0, 0, err
	}
	defer f.Close()
	switch {
	case rePagePath.MatchString(rel) || rel == "t.webp":
		if size > maxWebPBytes {
			return "", 0, 0, errors.New("too large")
		}
		b, err := head(f, 64)
		if err != nil {
			return "", 0, 0, err
		}
		w, h, err = webpSize(b)
		if err != nil {
			return "", 0, 0, err
		}
		if int64(binary.LittleEndian.Uint32(b[4:])) != size-8 {
			return "", 0, 0, errors.New("riff size does not match the file")
		}
		if m := rePagePath.FindStringSubmatch(rel); m != nil {
			if width, _ := strconv.Atoi(m[2]); w != width || h < 1 {
				return "", 0, 0, fmt.Errorf("width %d, want %d", w, width)
			}
		} else if w > thumbWidth || w < 1 || h < 1 {
			return "", 0, 0, fmt.Errorf("thumbnail is %dx%d", w, h)
		}
		return "image/webp", w, h, nil
	case rel == "i/1920.jpg":
		if size > maxJPEGBytes {
			return "", 0, 0, errors.New("too large")
		}
		b, err := head(f, 64<<10)
		if err != nil {
			return "", 0, 0, err
		}
		w, h, err = jpegSize(b)
		if err != nil {
			return "", 0, 0, err
		}
		end, err := tail(f, size, 2)
		if err != nil || len(end) < 2 || end[0] != 0xFF || end[1] != 0xD9 {
			return "", 0, 0, errors.New("jpeg is truncated")
		}
		if w > jpegWidth || h > jpegWidth*8 || w < 1 || h < 1 {
			return "", 0, 0, fmt.Errorf("jpeg is %dx%d", w, h)
		}
		return "image/jpeg", w, h, nil
	case rel == "doc.pdf":
		if size > maxPDFBytes {
			return "", 0, 0, errors.New("too large")
		}
		b, err := head(f, 8)
		if err != nil || !bytes.HasPrefix(b, []byte("%PDF-")) {
			return "", 0, 0, errors.New("not a pdf")
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return "", 0, 0, err
		}
		active, err := hasPDFActive(f)
		if err != nil {
			return "", 0, 0, err
		}
		if active {
			return "", 0, 0, errors.New("pdf carries active content")
		}
		return "application/pdf", 0, 0, nil
	case reVideoPath.MatchString(rel):
		if size > maxMP4Bytes {
			return "", 0, 0, errors.New("too large")
		}
		b, err := head(f, 12)
		if err != nil || len(b) < 12 || string(b[4:8]) != "ftyp" {
			return "", 0, 0, errors.New("not an mp4")
		}
		return "video/mp4", 0, 0, nil
	case rel == "slides.json" || rel == "notes.json" || rel == "meta.json":
		if size > maxJSONBytes {
			return "", 0, 0, errors.New("too large")
		}
		return "application/json", 0, 0, nil
	}
	return "", 0, 0, errors.New("unexpected file")
}

func checkRequired(want expectation, seen map[string]bool, pages map[int]map[int]bool) error {
	need := []string{"meta.json", "t.webp"}
	switch want.kind {
	case kindVideo:
		need = append(need, "m/0.mp4")
	case kindImage:
		need = append(need, "i/1920.jpg")
	default:
		need = append(need, "doc.pdf", "slides.json", "notes.json")
	}
	for _, n := range need {
		if !seen[n] {
			return invalid("missing %s", n)
		}
	}
	if want.kind == kindVideo || want.kind == kindImage {
		if len(pages) > 0 {
			return invalid("page images in a %s job", want.kind)
		}
		return nil
	}
	if len(pages) != want.pages {
		return invalid("%d pages rendered, want %d", len(pages), want.pages)
	}
	for n := 1; n <= want.pages; n++ {
		for _, w := range pageWidths {
			if !pages[n][w] {
				return invalid("page %d has no %d image", n, w)
			}
		}
	}
	return nil
}

func readJSON(dir, name string, v any) error {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return invalid("%s: %v", name, err)
	}
	return nil
}

func checkJSONFiles(dir string, want expectation, dims map[string][2]int) error {
	var meta metaJSON
	if err := readJSON(dir, "meta.json", &meta); err != nil {
		return err
	}
	if meta.V != 1 || len(meta.SHA256) != 64 || meta.Kind != want.kind || meta.FontsMissing == nil {
		return invalid("meta.json has the wrong shape")
	}
	if _, err := hex.DecodeString(meta.SHA256); err != nil {
		return invalid("meta.json sha256: %v", err)
	}
	if want.kind == kindVideo || want.kind == kindImage {
		return nil
	}
	var slides slidesJSON
	if err := readJSON(dir, "slides.json", &slides); err != nil {
		return err
	}
	if slides.V != 1 || len(slides.Pages) != want.pages {
		return invalid("slides.json has %d pages, want %d", len(slides.Pages), want.pages)
	}
	for i, p := range slides.Pages {
		got := dims[fmt.Sprintf("s/%d/%d.webp", p.N, pageWidths[0])]
		if p.N != i+1 || p.W != got[0] || p.H != got[1] {
			return invalid("slides.json page %d does not match its image", i+1)
		}
	}
	var notes notesJSON
	if err := readJSON(dir, "notes.json", &notes); err != nil {
		return err
	}
	if notes.V != 1 || notes.Notes == nil {
		return invalid("notes.json has the wrong shape")
	}
	last := 0
	for _, n := range notes.Notes {
		if n.N <= last || n.N > want.pages || n.Text == "" || !utf8.ValidString(n.Text) || utf8.RuneCountInString(n.Text) > maxNoteRunes {
			return invalid("notes.json entry %d is not valid", n.N)
		}
		last = n.N
	}
	return nil
}
