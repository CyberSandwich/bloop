package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	nsA = "http://schemas.openxmlformats.org/drawingml/2006/main"
	nsP = "http://schemas.openxmlformats.org/presentationml/2006/main"
	nsR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

	maxPartBytes = 16 << 20 // the largest XML part we parse
	maxNoteRunes = 4000
)

// Limits bound what a package may unpack to.
type Limits struct {
	MaxUnpacked int64 // decompressed total, declared and actual
	MaxEntries  int
}

// Note is one slide's speaker notes. n is the 1-based slide number.
type Note struct {
	N    int    `json:"n"`
	Text string `json:"text"`
}

// Analysis is what the Go inspector learns about an OOXML package without converting it.
type Analysis struct {
	Notes  []Note
	Fonts  []string // every typeface the package names, deduplicated, sorted
	Motion bool     // any animation or transition
	Media  bool     // any embedded audio or video
}

// verifyArchive refuses a package that would unpack past the limits. Declared sizes are checked
// first (cheap), then each entry is actually inflated up to its declared size plus one byte, so a
// header that lies about its size still trips the total.
func verifyArchive(zr *zip.Reader, lim Limits) error {
	if len(zr.File) > lim.MaxEntries {
		return errors.New("too many entries")
	}
	var declared uint64
	for _, f := range zr.File {
		declared += f.UncompressedSize64
		if declared > uint64(lim.MaxUnpacked) {
			return errBombSize
		}
	}
	var actual int64
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("open %s: %w", f.Name, err)
		}
		n, err := io.Copy(io.Discard, io.LimitReader(rc, int64(f.UncompressedSize64)+1))
		rc.Close()
		if err != nil {
			return fmt.Errorf("read %s: %w", f.Name, err)
		}
		actual += n
		if uint64(n) > f.UncompressedSize64 || actual > lim.MaxUnpacked {
			return errBombSize
		}
	}
	return nil
}

var errBombSize = errors.New("archive unpacks past the limit")

// pkg indexes a package's entries by name.
type pkg struct {
	list   []*zip.File
	byName map[string]*zip.File
}

func newPkg(zr *zip.Reader) *pkg {
	p := &pkg{list: zr.File, byName: make(map[string]*zip.File, len(zr.File))}
	for _, f := range zr.File {
		p.byName[f.Name] = f
	}
	return p
}

// readFile returns one entry, capped at maxPartBytes.
func readFile(f *zip.File) ([]byte, bool) {
	rc, err := f.Open()
	if err != nil {
		return nil, false
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, maxPartBytes))
	return b, err == nil
}

// part returns the named entry, or false when absent or unreadable.
func (p *pkg) part(name string) ([]byte, bool) {
	f, ok := p.byName[name]
	if !ok {
		return nil, false
	}
	return readFile(f)
}

type relationship struct{ id, typ, target string }

func parseRels(b []byte) []relationship {
	var out []relationship
	d := xml.NewDecoder(bytes.NewReader(b))
	for {
		tok, err := d.Token()
		if err != nil {
			return out
		}
		if el, ok := tok.(xml.StartElement); ok && el.Name.Local == "Relationship" {
			var r relationship
			for _, a := range el.Attr {
				switch a.Name.Local {
				case "Id":
					r.id = a.Value
				case "Type":
					r.typ = a.Value
				case "Target":
					r.target = a.Value
				}
			}
			out = append(out, r)
		}
	}
}

// resolve turns a relationship target into a part name, relative to the part that owns the rels.
func resolve(ownerDir, target string) string {
	if strings.HasPrefix(target, "/") {
		return strings.TrimPrefix(path.Clean(target), "/")
	}
	return path.Join(ownerDir, target)
}

func relsName(part string) string {
	return path.Join(path.Dir(part), "_rels", path.Base(part)+".rels")
}

func relOfType(rels []relationship, suffix string) (relationship, bool) {
	for _, r := range rels {
		if strings.HasSuffix(r.typ, suffix) {
			return r, true
		}
	}
	return relationship{}, false
}

// slideParts lists the slide part names in presentation order.
func slideParts(p *pkg) []string {
	pres, ok := p.part("ppt/presentation.xml")
	if !ok {
		return nil
	}
	relsBytes, _ := p.part(relsName("ppt/presentation.xml"))
	byID := map[string]string{}
	for _, r := range parseRels(relsBytes) {
		byID[r.id] = resolve("ppt", r.target)
	}
	var out []string
	d := xml.NewDecoder(bytes.NewReader(pres))
	for {
		tok, err := d.Token()
		if err != nil {
			return out
		}
		el, ok := tok.(xml.StartElement)
		if !ok || el.Name.Local != "sldId" {
			continue
		}
		for _, a := range el.Attr {
			if a.Name.Space == nsR && a.Name.Local == "id" {
				if part, ok := byID[a.Value]; ok {
					out = append(out, part)
				}
			}
		}
	}
}

// notesText returns the text of the body placeholder of one notes slide, paragraphs joined by
// newlines. Slide image, slide number, header, footer and date placeholders are not notes.
func notesText(b []byte) string {
	d := xml.NewDecoder(bytes.NewReader(b))
	type shape struct {
		hasPh   bool
		phType  string
		paras   []string
		current strings.Builder
		inPara  bool
	}
	var stack []*shape
	var inText bool
	var out []string
	flush := func(s *shape) {
		if s.inPara {
			s.paras = append(s.paras, s.current.String())
			s.current.Reset()
			s.inPara = false
		}
	}
	for {
		tok, err := d.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch {
			case t.Name.Space == nsP && t.Name.Local == "sp":
				stack = append(stack, &shape{})
			case len(stack) == 0:
			case t.Name.Space == nsP && t.Name.Local == "ph":
				s := stack[len(stack)-1]
				s.hasPh = true
				for _, a := range t.Attr {
					if a.Name.Local == "type" {
						s.phType = a.Value
					}
				}
			case t.Name.Space == nsA && t.Name.Local == "p":
				s := stack[len(stack)-1]
				flush(s)
				s.inPara = true
			case t.Name.Space == nsA && t.Name.Local == "br":
				stack[len(stack)-1].current.WriteByte('\n')
			case t.Name.Space == nsA && t.Name.Local == "t":
				inText = true
			}
		case xml.CharData:
			if inText && len(stack) > 0 {
				stack[len(stack)-1].current.Write(t)
			}
		case xml.EndElement:
			switch {
			case t.Name.Space == nsA && t.Name.Local == "t":
				inText = false
			case t.Name.Space == nsP && t.Name.Local == "sp" && len(stack) > 0:
				s := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				flush(s)
				if s.hasPh && (s.phType == "body" || s.phType == "") {
					out = append(out, s.paras...)
				}
			}
		}
	}
	return strings.TrimSpace(stripControls(strings.Join(out, "\n")))
}

func capRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

var (
	reLatin   = regexp.MustCompile(`<(?:\w+:)?latin\b[^>]*\btypeface="([^"]*)"`)
	reRFonts  = regexp.MustCompile(`\bw:(?:ascii|hAnsi)="([^"]*)"`)
	reWFont   = regexp.MustCompile(`<w:font\b[^>]*\bw:name="([^"]*)"`)
	reXlsName = regexp.MustCompile(`<name\b[^>]*\bval="([^"]*)"`)
	reMotion  = regexp.MustCompile(`<(?:\w+:)?(?:timing|transition)[\s>/]`)
	reMedia   = regexp.MustCompile(`Type="[^"]*/(?:video|audio|media)"`)
)

var mediaExts = map[string]bool{
	".mp4": true, ".m4v": true, ".mov": true, ".wmv": true, ".avi": true, ".mpg": true, ".mpeg": true, ".webm": true,
	".mp3": true, ".m4a": true, ".wav": true, ".wma": true, ".mid": true, ".midi": true, ".aac": true, ".flac": true, ".ogg": true,
}

// analyzeOOXML reads notes, fonts, motion and media out of a pptx, docx or xlsx.
func analyzeOOXML(p *pkg) Analysis {
	var a Analysis
	fonts := map[string]string{} // lower-case -> first spelling seen
	add := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" || strings.HasPrefix(name, "+") {
			return
		}
		if _, seen := fonts[strings.ToLower(name)]; !seen {
			fonts[strings.ToLower(name)] = name
		}
	}
	for _, f := range p.list {
		name := f.Name
		lower := strings.ToLower(name)
		if mediaExts[path.Ext(lower)] && (strings.HasPrefix(lower, "ppt/media/") || strings.HasPrefix(lower, "ppt/embeddings/")) {
			a.Media = true
		}
		if !strings.HasSuffix(lower, ".xml") && !strings.HasSuffix(lower, ".rels") {
			continue
		}
		inDeck := strings.HasPrefix(name, "ppt/slides/") || strings.HasPrefix(name, "ppt/slideLayouts/") || strings.HasPrefix(name, "ppt/slideMasters/")
		switch {
		case strings.HasSuffix(lower, ".rels") && strings.HasPrefix(name, "ppt/slides/"):
			b, _ := readFile(f)
			if reMedia.Match(b) {
				a.Media = true
			}
		case inDeck && strings.HasSuffix(lower, ".xml"):
			b, _ := readFile(f)
			if reMotion.Match(b) {
				a.Motion = true
			}
			for _, m := range reLatin.FindAllSubmatch(b, -1) {
				add(string(m[1]))
			}
		case strings.HasPrefix(name, "ppt/theme/") || strings.HasPrefix(name, "ppt/notesSlides/") || strings.HasPrefix(name, "ppt/notesMasters/"):
			b, _ := readFile(f)
			for _, m := range reLatin.FindAllSubmatch(b, -1) {
				add(string(m[1]))
			}
		case name == "word/fontTable.xml":
			b, _ := readFile(f)
			for _, m := range reWFont.FindAllSubmatch(b, -1) {
				add(string(m[1]))
			}
		case strings.HasPrefix(name, "word/") && strings.HasSuffix(lower, ".xml"):
			b, _ := readFile(f)
			for _, m := range reRFonts.FindAllSubmatch(b, -1) {
				add(string(m[1]))
			}
			for _, m := range reLatin.FindAllSubmatch(b, -1) {
				add(string(m[1]))
			}
		case name == "xl/styles.xml":
			b, _ := readFile(f)
			for _, m := range reXlsName.FindAllSubmatch(b, -1) {
				add(string(m[1]))
			}
		}
	}
	for _, v := range fonts {
		a.Fonts = append(a.Fonts, v)
	}
	sort.Strings(a.Fonts)
	n := 0
	for _, part := range slideParts(p) {
		if slide, ok := p.part(part); ok && slideHidden(slide) {
			continue // LibreOffice leaves hidden slides out of the PDF, so they take no page number
		}
		n++
		rels, _ := p.part(relsName(part))
		r, ok := relOfType(parseRels(rels), "/notesSlide")
		if !ok {
			continue
		}
		b, ok := p.part(resolve(path.Dir(part), r.target))
		if !ok {
			continue
		}
		if text := notesText(b); text != "" {
			a.Notes = append(a.Notes, Note{N: n, Text: capRunes(text, maxNoteRunes)})
		}
	}
	return a
}

// slideHidden reports whether a slide part's root says show="0".
func slideHidden(b []byte) bool {
	d := xml.NewDecoder(bytes.NewReader(b))
	for {
		tok, err := d.Token()
		if err != nil {
			return false
		}
		if el, ok := tok.(xml.StartElement); ok {
			for _, a := range el.Attr {
				if a.Name.Local == "show" && (a.Value == "0" || a.Value == "false") {
					return true
				}
			}
			return false
		}
	}
}

// stripControls drops every control character except a newline.
func stripControls(s string) string {
	return strings.Map(func(r rune) rune {
		if r != '\n' && unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
}

const (
	maxFontsMissing = 50
	maxFontRunes    = 100
)

// capFonts bounds the fontsMissing list: names cut to maxFontRunes, sorted, at most maxFontsMissing.
func capFonts(names []string) []string {
	out := make([]string, 0, min(len(names), maxFontsMissing))
	for _, n := range names {
		n = strings.TrimSpace(strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return -1
			}
			return r
		}, n))
		if n != "" {
			out = append(out, capRunes(n, maxFontRunes))
		}
	}
	sort.Strings(out)
	return out[:min(len(out), maxFontsMissing)]
}

// metricAliases are families LibreOffice renders with a metric-compatible font we ship, so a deck
// that names them is not missing anything.
var metricAliases = map[string]string{
	"calibri": "carlito", "cambria": "caladea",
	"arial": "liberation sans", "helvetica": "liberation sans", "arial narrow": "liberation sans narrow",
	"times new roman": "liberation serif", "times": "liberation serif",
	"courier new": "liberation mono", "courier": "liberation mono",
}

// missingFonts returns the names in used that neither an installed family nor a metric alias covers.
// installed holds lower-case family names.
func missingFonts(used []string, installed map[string]bool) []string {
	out := []string{}
	for _, name := range used {
		l := strings.ToLower(name)
		if installed[l] {
			continue
		}
		if alias, ok := metricAliases[l]; ok && installed[alias] {
			continue
		}
		out = append(out, name)
	}
	return out
}

// parseFcList reads `fc-list : family` output: one line per face, comma-separated alias names.
func parseFcList(b []byte) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		for _, fam := range strings.Split(line, ",") {
			if fam = strings.ToLower(strings.TrimSpace(fam)); fam != "" {
				out[fam] = true
			}
		}
	}
	return out
}
