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
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
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

// Output groups. A group is published or withheld as a whole; one failing never hides another.
const (
	groupSlides = "slides"
	groupPDF    = "pdf"
	groupNotes  = "notes"
	groupMedia  = "media"
	groupImage  = "image"
	groupMeta   = "meta"
)

var defaultWidths = []int{3840, 1920, 480}

var (
	rePagePath  = regexp.MustCompile(`^s/([1-9][0-9]*)/([0-9]+)\.webp$`)
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
	Widths []int     `json:"widths"`
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

// GroupResult is one group's verdict in the manifest.
type GroupResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
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
	kind   string
	pages  int   // office and pdf kinds: pages rendered
	widths []int // rendered widths, widest first
}

// groupsFor lists the groups a kind must produce.
func groupsFor(kind string) []string {
	switch kind {
	case kindVideo:
		return []string{groupMedia}
	case kindImage:
		return []string{groupImage}
	}
	return []string{groupSlides, groupPDF, groupNotes}
}

// groupOf maps an output path to its group for a kind. The thumbnail belongs to the kind's visual group.
func groupOf(rel, kind string) (string, bool) {
	switch {
	case rel == "meta.json":
		return groupMeta, true
	case rel == "t.webp":
		return groupsFor(kind)[0], true
	case rel == "doc.pdf":
		return groupPDF, true
	case rel == "notes.json":
		return groupNotes, true
	case rel == "slides.json" || rePagePath.MatchString(rel):
		return groupSlides, true
	case reVideoPath.MatchString(rel):
		return groupMedia, true
	case rel == "i/1920.jpg":
		return groupImage, true
	}
	return "", false
}

// validateOutputs walks dir. Anything that is not a regular file, any unknown name and any total
// over the cap fail the whole job. Everything else is judged per group: a failing group is left out
// of the returned files and reported in the group map, and the others are published. Only when every
// expected group fails (or meta.json is bad) is the job itself invalid.
func validateOutputs(dir string, want expectation) ([]OutFile, map[string]GroupResult, error) {
	type found struct {
		rel  string
		size int64
	}
	byGroup := map[string][]found{}
	var total int64
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
		group, ok := groupOf(rel, want.kind)
		if !ok {
			return invalid("%s is an unexpected file", rel)
		}
		if total += info.Size(); total > maxTotal {
			return invalid("outputs exceed %d bytes", int64(maxTotal))
		}
		byGroup[group] = append(byGroup[group], found{rel, info.Size()})
		return nil
	})
	if err != nil {
		return nil, nil, err
	}

	failed := map[string]string{}
	dims := map[string][2]int{}
	pages := map[int]map[int]bool{}
	types := map[string]string{}
	for group, list := range byGroup {
		for _, f := range list {
			p := filepath.Join(dir, filepath.FromSlash(f.rel))
			typ, w, h, err := checkFile(p, f.rel, f.size, want.widths)
			if err != nil {
				log.Printf("output %s: %v", f.rel, err)
				failed[group] = errOutputInvalid
				continue
			}
			types[f.rel] = typ
			if w > 0 {
				dims[f.rel] = [2]int{w, h}
			}
			if m := rePagePath.FindStringSubmatch(f.rel); m != nil {
				n, _ := strconv.Atoi(m[1])
				width, _ := strconv.Atoi(m[2])
				if pages[n] == nil {
					pages[n] = map[int]bool{}
				}
				pages[n][width] = true
			}
		}
	}
	if _, bad := failed[groupMeta]; bad || len(byGroup[groupMeta]) == 0 {
		return nil, nil, invalid("meta.json is missing or bad")
	}
	if err := checkMeta(dir, want); err != nil {
		return nil, nil, err
	}
	have := func(g, rel string) bool {
		for _, f := range byGroup[g] {
			if f.rel == rel {
				return true
			}
		}
		return false
	}
	need := func(g string, rels ...string) {
		for _, r := range rels {
			if !have(g, r) {
				log.Printf("group %s: missing %s", g, r)
				failed[g] = errOutputInvalid
			}
		}
	}
	for _, g := range groupsFor(want.kind) {
		switch g {
		case groupSlides:
			need(g, "slides.json", "t.webp")
			for n := 1; n <= want.pages; n++ {
				for _, w := range want.widths {
					if !pages[n][w] {
						log.Printf("group slides: page %d has no %d image", n, w)
						failed[g] = errOutputInvalid
					}
				}
			}
			if len(pages) != want.pages {
				log.Printf("group slides: %d pages rendered, want %d", len(pages), want.pages)
				failed[g] = errOutputInvalid
			}
			if failed[g] == "" {
				if err := checkSlides(dir, want, dims); err != nil {
					log.Printf("group slides: %v", err)
					failed[g] = errOutputInvalid
				}
			}
		case groupPDF:
			need(g, "doc.pdf")
		case groupNotes:
			need(g, "notes.json")
			if failed[g] == "" {
				if err := checkNotes(dir, want); err != nil {
					log.Printf("group notes: %v", err)
					failed[g] = errOutputInvalid
				}
			}
		case groupMedia:
			need(g, "m/0.mp4", "t.webp")
		case groupImage:
			need(g, "i/1920.jpg", "t.webp")
		}
	}

	results := map[string]GroupResult{}
	var files []OutFile
	passing := 0
	for _, g := range groupsFor(want.kind) {
		if code, bad := failed[g]; bad {
			results[g] = GroupResult{OK: false, Error: code}
			continue
		}
		results[g] = GroupResult{OK: true}
		passing++
		for _, f := range byGroup[g] {
			sum, err := fileSHA256(filepath.Join(dir, filepath.FromSlash(f.rel)))
			if err != nil {
				return nil, nil, err
			}
			files = append(files, OutFile{Path: f.rel, Size: f.size, SHA256: sum, Type: types[f.rel]})
		}
	}
	if passing == 0 {
		return nil, nil, invalid("every output group failed")
	}
	meta := byGroup[groupMeta][0]
	sum, err := fileSHA256(filepath.Join(dir, "meta.json"))
	if err != nil {
		return nil, nil, err
	}
	files = append(files, OutFile{Path: "meta.json", Size: meta.size, SHA256: sum, Type: "application/json"})
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, results, nil
}

// checkFile validates one output by its relative path and returns its MIME type and, for images, its size.
func checkFile(p, rel string, size int64, widths []int) (typ string, w, h int, err error) {
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
			if width, _ := strconv.Atoi(m[2]); !slices.Contains(widths, width) || w != width || h < 1 {
				return "", 0, 0, fmt.Errorf("width %d, want %s", w, m[2])
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

func checkMeta(dir string, want expectation) error {
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
	return nil
}

func checkSlides(dir string, want expectation, dims map[string][2]int) error {
	var slides slidesJSON
	if err := readJSON(dir, "slides.json", &slides); err != nil {
		return err
	}
	if slides.V != 1 || len(slides.Pages) != want.pages || !slices.Equal(slides.Widths, want.widths) {
		return invalid("slides.json has %d pages and widths %v, want %d and %v", len(slides.Pages), slides.Widths, want.pages, want.widths)
	}
	for i, p := range slides.Pages {
		got := dims[fmt.Sprintf("s/%d/%d.webp", p.N, want.widths[0])]
		if p.N != i+1 || p.W != got[0] || p.H != got[1] {
			return invalid("slides.json page %d does not match its image", i+1)
		}
	}
	return nil
}

func checkNotes(dir string, want expectation) error {
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
