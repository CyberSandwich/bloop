package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
)

// hevcProbe is ffprobe's answer for an HEVC upload of the given size and length.
func hevcProbe(w, h int, duration string) string {
	return fmt.Sprintf(`{"streams":[{"codec_type":"video","codec_name":"hevc","width":%d,"height":%d},{"codec_type":"audio","codec_name":"aac","profile":"LC"}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":%q}}`,
		w, h, duration)
}

// widthOf is the size cap an encode's scale filter names first (the width, or the long side of a 720p), or 0 for any
// other ffmpeg run.
func widthOf(spec cmdSpec) int {
	joined := strings.Join(spec.args, " ")
	var w int
	if i := strings.Index(joined, "scale="); i >= 0 && strings.Contains(joined, "libx264") {
		if j := strings.Index(joined[i:], "min("); j >= 0 {
			fmt.Sscanf(joined[i+j+len("min("):], "%d", &w)
		}
	}
	return w
}

// scaleOf is the scale filter of an encode, or "" for any other ffmpeg run.
func scaleOf(spec cmdSpec) string {
	joined := strings.Join(spec.args, " ")
	if i := strings.Index(joined, "scale="); i >= 0 && strings.Contains(joined, "libx264") {
		return joined[i:]
	}
	return ""
}

// probeWithRotation is hevcProbe with a display matrix turning the picture a quarter.
func probeWithRotation(w, h int, duration string, rotation int) string {
	return strings.Replace(hevcProbe(w, h, duration), `"height":`+fmt.Sprint(h), fmt.Sprintf(`"height":%d,"side_data_list":[{"rotation":%d}]`, h, rotation), 1)
}

func encodeWidths(tools *fakeTools) []int {
	var out []int
	for _, c := range tools.called("ffmpeg") {
		if w := widthOf(c); w > 0 {
			out = append(out, w)
		}
	}
	return out
}

func TestAnHEVCSourceWiderThanThePreviewIsEncodedAt720pFirstAndListedReadyBeforeTheFullEncode(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = hevcProbe(1920, 1080, "100")
	h := newHarness(t, tools)
	var readyAtFull Status
	var previewCode int
	var preview Manifest
	var fullSeen bool
	served := map[string]string{}
	tools.onRun = func(spec cmdSpec) {
		if widthOf(spec) != 1920 || fullSeen {
			return
		}
		fullSeen = true
		readyAtFull = h.status()
		code, body, _ := h.get("/out/preview.json")
		previewCode = code
		_ = json.Unmarshal(body, &preview)
		for _, p := range readyAtFull.Ready {
			_, b, _ := h.get("/out/" + p)
			served[p] = sum(b)
		}
	}
	h.post("j1", "mov", fakeFaststartMP4)
	m := h.mustSucceed(h.wait())

	if got := encodeWidths(tools); !slices.Equal(got, []int{1280, 1920}) {
		t.Fatalf("encode widths = %v, want the 720p then the full size", got)
	}
	if !slices.Equal(readyAtFull.Ready, []string{"m/720.mp4", "t.webp", "meta.json"}) {
		t.Fatalf("ready when the full encode starts = %v", readyAtFull.Ready)
	}
	if previewCode != http.StatusOK || preview.JobID != "j1" || preview.Kind != kindVideo || preview.Pages != nil || !preview.Groups[groupMedia].OK {
		t.Fatalf("preview manifest %d: %+v", previewCode, preview)
	}
	var paths []string
	for _, f := range preview.Files {
		paths = append(paths, f.Path)
		if len(f.SHA256) != 64 || f.Size == 0 {
			t.Errorf("preview file %+v", f)
		}
	}
	slices.Sort(paths)
	if !slices.Equal(paths, []string{"m/720.mp4", "meta.json", "t.webp"}) {
		t.Fatalf("preview files = %v", paths)
	}
	// What a caller fetches while the full encode runs is what the preview manifest says.
	for _, f := range preview.Files {
		if served[f.Path] != f.SHA256 {
			t.Errorf("%s served with hash %s, manifest says %s", f.Path, served[f.Path], f.SHA256)
		}
	}
	// The finished job replaces the 720p: one mp4, and nothing listed ready or left on disk.
	if !m.has("m/0.mp4") || m.has("m/720.mp4") || !m.has("t.webp") || !m.has("meta.json") {
		t.Fatalf("final files: %+v", m.Files)
	}
	if _, err := os.Stat(h.srv.dir("out", "m", "720.mp4")); !os.IsNotExist(err) {
		t.Fatalf("the 720p is in the outputs: %v", err)
	}
	// The thumbnail of the full encode is its own file, not the preview's rewritten.
	for _, f := range m.Files {
		if f.Path == "t.webp" && f.SHA256 == served["t.webp"] {
			t.Errorf("the final thumbnail has the preview thumbnail's bytes")
		}
	}
	if st := h.status(); len(st.Ready) != 0 {
		t.Fatalf("ready after done = %v", st.Ready)
	}
	if code, _, _ := h.get("/out/preview.json"); code != http.StatusConflict {
		t.Fatalf("preview.json after done answers %d", code)
	}
}

func TestAFullEncodeThatFailsLeavesThe720pAsTheJobsOutput(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = hevcProbe(1920, 1080, "100")
	tools.failWidth = "min(1920,"
	h := newHarness(t, tools)
	var previewThumb string
	tools.onRun = func(spec cmdSpec) {
		if widthOf(spec) == 1920 && previewThumb == "" {
			_, b, _ := h.get("/out/t.webp")
			previewThumb = sum(b)
		}
	}
	h.post("j1", "mov", fakeFaststartMP4)
	m := h.mustSucceed(h.wait())
	if !m.has("m/720.mp4") || m.has("m/0.mp4") || !m.has("t.webp") || !m.has("meta.json") {
		t.Fatalf("a failed full encode must leave the 720p alone: %+v", m.Files)
	}
	for _, f := range m.Files {
		if f.Path == "t.webp" && f.SHA256 != previewThumb {
			t.Errorf("the kept thumbnail is not the 720p's")
		}
	}
	if _, err := os.Stat(h.srv.dir("out", "m", "0.mp4")); !os.IsNotExist(err) {
		t.Fatalf("a partial full encode is still on disk: %v", err)
	}
}

func TestA720pThatFailsIsNotListedAndTheFullEncodeStillRuns(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = hevcProbe(1920, 1080, "100")
	tools.failWidth = "min(1280,"
	h := newHarness(t, tools)
	h.post("j1", "mov", fakeFaststartMP4)
	m := h.mustSucceed(h.wait())
	if !m.has("m/0.mp4") || m.has("m/720.mp4") {
		t.Fatalf("files: %+v", m.Files)
	}
	if code, _, _ := h.get("/out/preview.json"); code != http.StatusConflict {
		t.Fatalf("preview.json answers %d with no 720p", code)
	}
}

func TestThe720pIsJudgedByTheDisplayedLongSideAndCapsIt(t *testing.T) {
	for _, tc := range []struct {
		name    string
		probeIn string
		preview bool
	}{
		{"a portrait 1080x1920 stored upright", hevcProbe(1080, 1920, "100"), true},
		{"a landscape file turned a quarter", probeWithRotation(1920, 1080, "100", -90), true},
		{"a 1280x720 file turned a quarter", probeWithRotation(1280, 720, "100", 90), false},
		{"a portrait 720x1280 is no longer than 1280", hevcProbe(720, 1280, "100"), false},
	} {
		name := tc.name
		tools := newFakeTools(0)
		tools.probeIn = tc.probeIn
		h := newHarness(t, tools)
		h.post("j1", "mov", fakeFaststartMP4)
		m := h.mustSucceed(h.wait())
		var first string
		for _, c := range tools.called("ffmpeg") {
			if scaleOf(c) != "" {
				first = scaleOf(c)
				break
			}
		}
		got := strings.Contains(first, "if(gte(iw,ih)")
		if got != tc.preview || !m.has("m/0.mp4") {
			t.Errorf("%s: 720p first = %v, want %v (first scale %q, files %+v)", name, got, tc.preview, first, m.Files)
		}
	}
}

func TestACopyAndAnH264EncodeNeverProduceA720p(t *testing.T) {
	for name, probeIn := range map[string]string{
		"a copy":                      h264Probe("High", "yuv420p", "aac", "100"),
		"an H.264 encode (High 10)":   h264Probe("High 10", "yuv420p10le", "aac", "100"),
		"HEVC no wider than the 720p": hevcProbe(1280, 720, "100"),
	} {
		tools := newFakeTools(0)
		tools.probeIn = probeIn
		h := newHarness(t, tools)
		sawReady := false
		tools.onRun = func(cmdSpec) {
			if slices.Contains(h.status().Ready, "m/720.mp4") {
				sawReady = true
			}
		}
		h.post("j1", "mp4", fakeFaststartMP4)
		m := h.mustSucceed(h.wait())
		if sawReady || m.has("m/720.mp4") || !m.has("m/0.mp4") {
			t.Errorf("%s: ready=%v files=%+v", name, sawReady, m.Files)
		}
		if slices.Contains(encodeWidths(tools), 1280) {
			t.Errorf("%s: encoded at the preview width", name)
		}
	}
}

func TestTheOutputCheckTakesOneMp4AndRefusesBoth(t *testing.T) {
	dir := t.TempDir()
	write := func(rel string, b []byte) {
		p := dir + "/" + rel
		if err := os.MkdirAll(p[:strings.LastIndex(p, "/")], 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	meta := `{"v":1,"sha256":"` + strings.Repeat("a", 64) + `","kind":"video","fontsMissing":[],"video":{"w":1280,"h":720,"durationMs":1500}}`
	want := expectation{kind: kindVideo, widths: defaultWidths}
	write("meta.json", []byte(meta))
	write("t.webp", fakeWebP(480, 270))
	write("m/720.mp4", fakeFaststartMP4)
	files, groups, err := validateOutputs(dir, want)
	if err != nil || !groups[groupMedia].OK || len(files) != 3 {
		t.Fatalf("the 720p alone: %v %+v %v", err, groups, files)
	}
	write("m/0.mp4", fakeFaststartMP4)
	if _, _, err := validateOutputs(dir, want); err == nil {
		t.Fatal("both mp4s present must fail the media group, and with it the only group")
	}
}
