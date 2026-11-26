package main

import (
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestPagesAreRenderedOnceUncompressedAndEncodedAtLowEffort(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	h.post("j1", "pdf", fakePDF)
	h.mustSucceed(h.wait())

	render := h.tools.called("pdftoppm")[0].args
	if slices.Contains(render, "-png") {
		t.Errorf("pdftoppm compresses to PNG, which costs more than the render: %v", render)
	}
	if n := len(h.tools.called("pdftoppm")); n != 1 {
		t.Errorf("%d renders for one page, want one for all widths", n)
	}
	for _, c := range h.tools.called("vips") {
		if c.args[0] != "copy" && c.args[0] != "thumbnail" {
			continue
		}
		if !strings.HasSuffix(c.args[1], ".ppm") {
			t.Errorf("vips %s reads %s, want the single PPM render", c.args[0], c.args[1])
		}
		if !strings.Contains(strings.Join(c.args, " "), "effort=2") {
			t.Errorf("vips %v encodes at the default effort", c.args)
		}
	}
}

func TestWorkersDefaultToTheCPUQuotaNotTheHostCount(t *testing.T) {
	cfg := loadConfig(func(string) string { return "" })
	if want := min(4, runtime.GOMAXPROCS(0)); cfg.Workers != want {
		t.Errorf("workers %d, want %d", cfg.Workers, want)
	}
}
