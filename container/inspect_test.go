package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
)

const (
	hdr    = `<?xml version="1.0"?>`
	nsAttr = ` xmlns:a="` + nsA + `" xmlns:p="` + nsP + `" xmlns:r="` + nsR + `"`
)

func notesXML(shapes ...string) string {
	return hdr + `<p:notes` + nsAttr + `><p:cSld><p:spTree>` + strings.Join(shapes, "") + `</p:spTree></p:cSld></p:notes>`
}

func shape(ph string, paragraphs ...string) string {
	var b strings.Builder
	b.WriteString(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>`)
	if ph != "" {
		b.WriteString(`<p:ph ` + ph + `/>`)
	}
	b.WriteString(`</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>`)
	for _, p := range paragraphs {
		b.WriteString(`<a:p>` + p + `</a:p>`)
	}
	b.WriteString(`</p:txBody></p:sp>`)
	return b.String()
}

func run(text string) string { return `<a:r><a:t>` + text + `</a:t></a:r>` }

func rels(items ...[3]string) string {
	var b strings.Builder
	b.WriteString(hdr + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for _, i := range items {
		b.WriteString(`<Relationship Id="` + i[0] + `" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/` + i[1] + `" Target="` + i[2] + `"/>`)
	}
	b.WriteString(`</Relationships>`)
	return b.String()
}

func TestNotesTextTakesOnlyTheBodyPlaceholder(t *testing.T) {
	x := notesXML(
		shape(`type="sldImg"`),
		shape(`type="body" idx="1"`, run("First line"), run("Second ")+run("line")+`<a:br/>`+run("after break")),
		shape(`type="sldNum" idx="5"`, `<a:fld type="slidenum"><a:t>7</a:t></a:fld>`),
		shape(``, run("a loose text box")),
	)
	want := "First line\nSecond line\nafter break"
	if got := notesText([]byte(x)); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestNotesTextEmptyBody(t *testing.T) {
	if got := notesText([]byte(notesXML(shape(`type="body"`, `<a:r><a:t>  </a:t></a:r>`)))); got != "" {
		t.Fatalf("got %q", got)
	}
}

// deck builds a pptx whose presentation order is slide2.xml then slide1.xml.
func deck(slide1Extra, slide2Extra string, notes map[string]string, extra ...[2]string) []byte {
	entries := [][2]string{
		{"ppt/presentation.xml", hdr + `<p:presentation` + nsAttr + `><p:sldIdLst><p:sldId id="256" r:id="rId5"/><p:sldId id="257" r:id="rId6"/></p:sldIdLst></p:presentation>`},
		{"ppt/_rels/presentation.xml.rels", rels([3]string{"rId5", "slide", "slides/slide2.xml"}, [3]string{"rId6", "slide", "slides/slide1.xml"})},
		{"ppt/slides/slide1.xml", hdr + `<p:sld` + nsAttr + `>` + slide1Extra + `</p:sld>`},
		{"ppt/slides/slide2.xml", hdr + `<p:sld` + nsAttr + `>` + slide2Extra + `</p:sld>`},
		{"ppt/slides/_rels/slide2.xml.rels", rels([3]string{"rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"})},
	}
	if n, ok := notes["slide1"]; ok {
		entries = append(entries,
			[2]string{"ppt/slides/_rels/slide1.xml.rels", rels([3]string{"rId4", "notesSlide", "../notesSlides/notesSlide1.xml"})},
			[2]string{"ppt/notesSlides/notesSlide1.xml", notesXML(shape(`type="body" idx="1"`, run(n)))},
		)
	}
	entries = append(entries, extra...)
	return mkZip(entries...)
}

func analyze(t *testing.T, b []byte) Analysis {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	return analyzeOOXML(newPkg(zr))
}

func TestAnalyzeNotesFollowPresentationOrderNotFileNames(t *testing.T) {
	a := analyze(t, deck("", "", map[string]string{"slide1": "second in the deck"}))
	if len(a.Notes) != 1 || a.Notes[0].N != 2 || a.Notes[0].Text != "second in the deck" {
		t.Fatalf("notes = %+v", a.Notes)
	}
}

func TestAnalyzeNotesCappedAtFourThousandRunes(t *testing.T) {
	long := strings.Repeat("é", 5000)
	a := analyze(t, deck("", "", map[string]string{"slide1": long}))
	if got := len([]rune(a.Notes[0].Text)); got != maxNoteRunes {
		t.Fatalf("runes = %d", got)
	}
}

func TestAnalyzeMotionAndMedia(t *testing.T) {
	plain := analyze(t, deck(`<p:cSld/>`, `<p:cSld/>`, nil))
	if plain.Motion || plain.Media {
		t.Fatalf("plain deck flagged: %+v", plain)
	}
	if a := analyze(t, deck(`<p:cSld/><p:transition spd="med"><p:fade/></p:transition>`, ``, nil)); !a.Motion {
		t.Error("transition not seen")
	}
	if a := analyze(t, deck(``, `<p:cSld/><p:timing><p:tnLst/></p:timing>`, nil)); !a.Motion {
		t.Error("timing not seen")
	}
	if a := analyze(t, deck(``, ``, nil, [2]string{"ppt/media/clip.mp4", "x"})); !a.Media {
		t.Error("embedded mp4 not seen")
	}
	if a := analyze(t, deck(``, ``, nil, [2]string{"ppt/slides/_rels/slide1.xml.rels", rels([3]string{"rId9", "video", "../media/clip.bin"})})); !a.Media {
		t.Error("video relationship not seen")
	}
}

func TestAnalyzeFontsIgnoreThemeReferencesAndDeduplicate(t *testing.T) {
	a := analyze(t, deck(
		`<a:latin typeface="Aptos"/><a:latin typeface="+mn-lt"/><a:latin typeface="aptos"/>`, ``, nil,
		[2]string{"ppt/theme/theme1.xml", `<a:theme xmlns:a="` + nsA + `"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont></a:theme>`},
	))
	if strings.Join(a.Fonts, "|") != "Aptos|Aptos Display" {
		t.Fatalf("fonts = %v", a.Fonts)
	}
}

func TestAnalyzeFontsInDocxAndXlsx(t *testing.T) {
	docx := mkZip(
		[2]string{"word/fontTable.xml", `<w:fonts xmlns:w="w"><w:font w:name="Aptos"/></w:fonts>`},
		[2]string{"word/document.xml", `<w:r><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr></w:r>`},
	)
	if got := strings.Join(analyze(t, docx).Fonts, "|"); got != "Aptos|Georgia" {
		t.Errorf("docx fonts = %s", got)
	}
	xlsx := mkZip([2]string{"xl/styles.xml", `<fonts><font><sz val="11"/><name val="Aptos Narrow"/></font></fonts>`})
	if got := strings.Join(analyze(t, xlsx).Fonts, "|"); got != "Aptos Narrow" {
		t.Errorf("xlsx fonts = %s", got)
	}
}

func TestMissingFontsAcceptsMetricAliases(t *testing.T) {
	installed := parseFcList([]byte("Carlito\nCaladea\nLiberation Sans\nLiberation Serif,Liberation\nNoto Sans\n"))
	got := missingFonts([]string{"Aptos", "Calibri", "Cambria", "Arial", "Times New Roman", "Courier New", "Noto Sans"}, installed)
	// Courier New needs Liberation Mono, which this installed set lacks.
	if strings.Join(got, "|") != "Aptos|Courier New" {
		t.Fatalf("missing = %v", got)
	}
	if got := missingFonts(nil, installed); got == nil || len(got) != 0 {
		t.Fatalf("empty input must give an empty, non-nil slice, got %#v", got)
	}
}

func openZip(t *testing.T, b []byte) *zip.Reader {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	return zr
}

func TestVerifyArchiveRefusesWhatUnpacksPastTheLimit(t *testing.T) {
	big := mkZip([2]string{"a.bin", strings.Repeat("\x00", 3<<20)})
	err := verifyArchive(openZip(t, big), Limits{MaxUnpacked: 1 << 20, MaxEntries: 10})
	if !errors.Is(err, errBombSize) {
		t.Fatalf("declared size: %v", err)
	}
	if err := verifyArchive(openZip(t, big), Limits{MaxUnpacked: 4 << 20, MaxEntries: 10}); err != nil {
		t.Fatalf("within the limit: %v", err)
	}
}

func TestVerifyArchiveRefusesTooManyEntries(t *testing.T) {
	var entries [][2]string
	for i := range 30 {
		entries = append(entries, [2]string{"f" + string(rune('a'+i%26)) + string(rune('a'+i/26)), "x"})
	}
	err := verifyArchive(openZip(t, mkZip(entries...)), Limits{MaxUnpacked: 1 << 20, MaxEntries: 10})
	if err == nil || !strings.Contains(err.Error(), "too many entries") {
		t.Fatalf("got %v", err)
	}
}

// A header that understates the size is refused: the entry is really inflated, and Go's reader
// fails an entry that runs past its declared size.
func TestVerifyArchiveCatchesAHeaderThatLiesAboutSize(t *testing.T) {
	b := mkZip([2]string{"a.bin", strings.Repeat("\x00", 4<<20)})
	i := bytes.LastIndex(b, []byte{0x50, 0x4b, 0x01, 0x02})
	if i < 0 {
		t.Fatal("no central directory")
	}
	binary.LittleEndian.PutUint32(b[i+24:], 10) // declared uncompressed size
	if err := verifyArchive(openZip(t, b), Limits{MaxUnpacked: 1 << 30, MaxEntries: 10}); err == nil {
		t.Fatal("an entry larger than its header says was accepted")
	}
}

func TestMagicOK(t *testing.T) {
	ftyp := func(brand string, compat ...string) []byte {
		b := []byte{0, 0, 0, byte(16 + 4*len(compat)), 'f', 't', 'y', 'p'}
		b = append(b, brand...)
		b = append(b, 0, 0, 0, 0)
		for _, c := range compat {
			b = append(b, c...)
		}
		return b
	}
	cases := []struct {
		ext  string
		head []byte
		ok   bool
	}{
		{"pptx", []byte("PK\x03\x04rest"), true},
		{"pptx", []byte("%PDF-1.7"), false},
		{"docx", []byte("not a zip"), false},
		{"ppt", []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0}, true},
		{"xls", []byte("PK\x03\x04"), false},
		{"pdf", []byte("%PDF-1.4\n"), true},
		{"pdf", append([]byte("junk\n"), "%PDF-1.4"...), true},
		{"pdf", []byte("<html>"), false},
		{"rtf", []byte(`{\rtf1`), true},
		{"mp4", ftyp("isom"), true},
		{"mov", ftyp("qt  "), true},
		{"mp4", []byte("PK\x03\x04aaaa"), false},
		{"mp4", []byte("short"), false},
		{"webm", []byte{0x1A, 0x45, 0xDF, 0xA3, 0}, true},
		{"webm", ftyp("isom"), false},
		{"heic", ftyp("heic"), true},
		{"heic", ftyp("mif1", "heic"), true},
		{"heif", ftyp("msf1"), true},
		{"heic", ftyp("avif", "mif1"), true}, // a mif1 compatible brand is still HEIF
		{"heic", ftyp("avif"), false},
		{"heic", ftyp("isom"), false},
		{"exe", []byte("MZ"), false},
	}
	for _, c := range cases {
		if got := magicOK(c.ext, c.head); got != c.ok {
			t.Errorf("magicOK(%s, %q) = %v, want %v", c.ext, c.head, got, c.ok)
		}
	}
}

func TestEveryKnownExtensionHasAMagicRule(t *testing.T) {
	for ext := range kindByExt {
		// An empty head must be refused by every rule, which also proves the rule exists.
		if magicOK(ext, nil) {
			t.Errorf("%s accepts an empty file", ext)
		}
	}
}

func TestPageSizeChecks(t *testing.T) {
	ok := []byte("Page    1 size: 960 x 540 pts\nPage    2 size: 595.276 x 841.89 pts (A4)\n")
	if err := checkPageSizes(ok, 2); err != nil {
		t.Fatal(err)
	}
	for name, in := range map[string]string{
		"too tall": "Page    1 size: 100 x 1000 pts\n",
		"too wide": "Page    1 size: 9000 x 100 pts\n",
		"zero":     "Page    1 size: 0 x 100 pts\n",
	} {
		if codeOf(checkPageSizes([]byte(in), 1)) != errBadPageSize {
			t.Errorf("%s not refused", name)
		}
	}
	if codeOf(checkPageSizes(ok, 3)) != errConvertFailed {
		t.Error("a missing page size must fail the job")
	}
	if pdfPageCount([]byte("Title: x\nPages:          301\n")) != 301 || pdfPageCount([]byte("nothing")) != 0 {
		t.Error("page count parse")
	}
}
