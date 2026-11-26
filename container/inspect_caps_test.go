package main

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func openPkg(t *testing.T, b []byte, budget int64) *pkg {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	return newPkg(zr, budget)
}

// numberedDeck is a pptx of n visible slides, each with a notes slide saying "notes K".
func numberedDeck(n int) []byte {
	var ids strings.Builder
	var rl [][3]string
	entries := [][2]string{}
	for k := 1; k <= n; k++ {
		ids.WriteString(fmt.Sprintf(`<p:sldId id="%d" r:id="rId%d"/>`, 255+k, k))
		rl = append(rl, [3]string{fmt.Sprintf("rId%d", k), "slide", fmt.Sprintf("slides/slide%d.xml", k)})
		entries = append(entries,
			[2]string{fmt.Sprintf("ppt/slides/slide%d.xml", k), hdr + `<p:sld` + nsAttr + `/>`},
			[2]string{fmt.Sprintf("ppt/slides/_rels/slide%d.xml.rels", k), rels([3]string{"rId1", "notesSlide", fmt.Sprintf("../notesSlides/notesSlide%d.xml", k)})},
			[2]string{fmt.Sprintf("ppt/notesSlides/notesSlide%d.xml", k), notesXML(shape(`type="body"`, run(fmt.Sprintf("notes %d", k))))},
		)
	}
	entries = append(entries,
		[2]string{"ppt/presentation.xml", hdr + `<p:presentation` + nsAttr + `><p:sldIdLst>` + ids.String() + `</p:sldIdLst></p:presentation>`},
		[2]string{"ppt/_rels/presentation.xml.rels", rels(rl...)},
	)
	return mkZip(entries...)
}

// A presentation that lists one 4 MB slide 500,000 times is read once, not 500,000 times: the bytes
// inflated stay within a few multiples of the parts' own sizes.
func TestRepeatedSlideIdsInflateTheSlideOnce(t *testing.T) {
	const budget = 1 << 30
	slide := hdr + `<p:sld` + nsAttr + `><!--` + strings.Repeat("x", 4<<20) + `--></p:sld>`
	ids := strings.Repeat(`<p:sldId id="256" r:id="rId5"/>`, 500_000)
	b := mkZip(
		[2]string{"ppt/presentation.xml", hdr + `<p:presentation` + nsAttr + `><p:sldIdLst>` + ids + `</p:sldIdLst></p:presentation>`},
		[2]string{"ppt/_rels/presentation.xml.rels", rels([3]string{"rId5", "slide", "slides/slide1.xml"})},
		[2]string{"ppt/slides/slide1.xml", slide},
	)
	p := openPkg(t, b, budget)
	if _, err := analyzeOOXML(context.Background(), p, 300); err != nil {
		t.Fatal(err)
	}
	if used := budget - p.left; used > maxPartBytes+3*int64(len(slide)) {
		t.Fatalf("inflated %d bytes for a %d byte slide", used, len(slide))
	}
}

func TestInflateBudgetStopsTheAnalysis(t *testing.T) {
	slide := hdr + `<p:sld` + nsAttr + `><!--` + strings.Repeat("x", 2<<20) + `--></p:sld>`
	b := mkZip([2]string{"ppt/slides/slide1.xml", slide})
	_, err := analyzeOOXML(context.Background(), openPkg(t, b, 1<<20), 300)
	if !errors.Is(err, errBombSize) {
		t.Fatalf("err = %v", err)
	}
}

func TestNotesStopAtMaxPages(t *testing.T) {
	a, err := analyzeOOXML(context.Background(), openPkg(t, numberedDeck(50), 1<<30), 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(a.Notes) != 3 || a.Notes[2].N != 3 {
		t.Fatalf("notes = %+v", a.Notes)
	}
}

func TestEndedContextStopsTheAnalysis(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := analyzeOOXML(ctx, openPkg(t, numberedDeck(5), 1<<30), 300); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

func TestSlidePartsStopWhenContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := slideParts(ctx, openPkg(t, numberedDeck(5), 1<<30)); len(got) > 1 {
		t.Fatalf("slideParts read on after the context ended: %v", got)
	}
}
