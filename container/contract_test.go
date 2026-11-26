package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestChunkedUploadIsAssembledInOrderAndHashed(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	body := append(bytes.Clone(fakePDF), bytes.Repeat([]byte("0123456789"), 50)...)
	if res := h.upload("j1", "pdf", body, 97); res.StatusCode != 202 {
		t.Fatalf("start: %d", res.StatusCode)
	}
	h.mustSucceed(h.wait())
	got, _ := os.ReadFile(filepath.Join(h.srv.cfg.WorkDir, "in", "original.pdf"))
	if !bytes.Equal(got, body) {
		t.Fatal("the assembled input differs from what was sent")
	}
	left, _ := filepath.Glob(filepath.Join(h.srv.cfg.WorkDir, "in", "chunk-*"))
	if len(left) != 0 {
		t.Fatalf("chunks left on disk: %v", left)
	}
	_, meta, _ := h.get("/out/meta.json")
	var mj metaJSON
	json.Unmarshal(meta, &mj)
	if mj.SHA256 != sum(body) {
		t.Fatalf("meta sha256 %s, want the whole input's %s", mj.SHA256, sum(body))
	}
}

func TestChunkSendAgainReplacesTheEarlierOne(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	h.do("PUT", "/job/input/0", []byte("%PDF-garbage"))
	if res := h.upload("j1", "pdf", fakePDF, 0); res.StatusCode != 202 {
		t.Fatalf("start: %d", res.StatusCode)
	}
	h.mustSucceed(h.wait())
}

func TestChunkOverTheChunkCapIsRefusedAndCanBeResent(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	h.srv.cfg.MaxChunk = 16
	res := h.do("PUT", "/job/input/0", bytes.Repeat([]byte("a"), 17))
	if res.StatusCode != 413 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if st := h.status(); st.State != stateIdle {
		t.Fatalf("an oversized chunk must not spend the container: %+v", st)
	}
	if res := h.upload("j1", "pdf", fakePDF, 16); res.StatusCode != 202 {
		t.Fatalf("resend: %d", res.StatusCode)
	}
	h.mustSucceed(h.wait())
}

func TestStartRefusesWhatDoesNotMatchAndLeavesTheContainerUnspent(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	h.do("PUT", "/job/input/0", fakePDF)

	bad := startRequest{JobID: "j1", Ext: "pdf", Size: int64(len(fakePDF)), SHA256: hex64, Chunks: 1}
	if res := h.do("POST", "/job/start", mustJSON(t, bad)); res.StatusCode != 422 {
		t.Fatalf("wrong sha256: %d", res.StatusCode)
	}
	bad = startRequest{JobID: "j1", Ext: "pdf", Size: 5, SHA256: sum(fakePDF), Chunks: 1}
	if res := h.do("POST", "/job/start", mustJSON(t, bad)); res.StatusCode != 422 {
		t.Fatalf("wrong size: %d", res.StatusCode)
	}
	bad = startRequest{JobID: "j1", Ext: "pdf", Size: int64(len(fakePDF)), SHA256: sum(fakePDF), Chunks: 2}
	if res := h.do("POST", "/job/start", mustJSON(t, bad)); res.StatusCode != 422 {
		t.Fatalf("missing chunk: %d", res.StatusCode)
	}
	if st := h.status(); st.State != stateIdle {
		t.Fatalf("a refused start spent the container: %+v", st)
	}
	if res := h.start("j1", "pdf", fakePDF, 1); res.StatusCode != 202 {
		t.Fatalf("a correct start after the refusals: %d", res.StatusCode)
	}
	h.mustSucceed(h.wait())
}

func TestStartedJobRefusesMoreChunks(t *testing.T) {
	tools := newFakeTools(1)
	tools.blockOn = "pdftocairo"
	h := newHarness(t, tools)
	h.srv.cfg.Timeouts["convert"] = time.Second
	h.post("j1", "pdf", fakePDF)
	if res := h.do("PUT", "/job/input/1", []byte("x")); res.StatusCode != 409 {
		t.Fatalf("chunk after start: %d", res.StatusCode)
	}
	h.wait()
}

func TestParseWidths(t *testing.T) {
	def := []int{3840, 1920, 480}
	for in, want := range map[string][]int{
		"":                 def,
		"2560,1280,320":    {2560, 1280, 320},
		" 1920 , 480":      {1920, 480},
		"480":              {480},
		"480,1920":         def, // not descending
		"1920,1920,480":    def,
		"3840,1920":        def, // the smallest must fit the thumbnail
		"1920,x,480":       def,
		"0,480":            def,
		"9000,480":         def,
		"4096,480":         def, // a 1:4 page would pass WebP's 16383 px side limit
		"4095,480":         {4095, 480},
		"6,5,4,3,2,1,0":    def,
		"7000,6,5,4,3,2,1": def, // more than six
	} {
		if got := parseWidths(in); !slices.Equal(got, want) {
			t.Errorf("parseWidths(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestWidthsConfigDrivesRenderingAndTheManifest(t *testing.T) {
	h := newHarness(t, newFakeTools(2))
	h.srv.cfg.Widths = []int{2560, 1280, 320}
	h.post("j1", "pdf", fakePDF)
	m := h.mustSucceed(h.wait())
	for _, p := range []string{"s/1/2560.webp", "s/1/1280.webp", "s/1/320.webp", "s/2/2560.webp", "t.webp"} {
		if !m.has(p) {
			t.Errorf("manifest lacks %s", p)
		}
	}
	if m.has("s/1/3840.webp") || m.has("s/1/480.webp") {
		t.Errorf("default widths leaked: %v", paths(m.Files))
	}
	_, b, _ := h.get("/out/slides.json")
	var sj slidesJSON
	json.Unmarshal(b, &sj)
	if !slices.Equal(sj.Widths, []int{2560, 1280, 320}) || sj.Pages[0].W != 2560 {
		t.Errorf("slides.json = %s", b)
	}
	if a := after(h.tools.called("pdftoppm")[0].args, "-scale-to-x"); a != "2560" {
		t.Errorf("pdftoppm scaled to %q", a)
	}
}

func TestCONV02CapsPageLimitTruncatesAndRecordsTheTrueCount(t *testing.T) {
	h := newHarness(t, newFakeTools(5))
	h.srv.cfg.MaxPages = 3
	h.post("j1", "pdf", fakePDF)
	m := h.mustSucceed(h.wait())
	if m.Pages == nil || *m.Pages != (PagesInfo{Total: 5, Rendered: 3}) {
		t.Fatalf("pages = %+v", m.Pages)
	}
	if !m.has("s/3/480.webp") || m.has("s/4/480.webp") {
		t.Fatalf("files = %v", paths(m.Files))
	}
	_, b, _ := h.get("/out/slides.json")
	var sj slidesJSON
	json.Unmarshal(b, &sj)
	if len(sj.Pages) != 3 {
		t.Fatalf("slides.json has %d pages", len(sj.Pages))
	}
	if st := h.status(); st.Pages == nil || *st.Pages != (PagesStatus{Done: 3, Total: 3}) {
		t.Fatalf("status pages = %+v", st.Pages)
	}
}

func TestPageOneIsFetchableBeforeTheJobIsDoneAndStatusCountsPages(t *testing.T) {
	tools := newFakeTools(3)
	tools.holdPages = make(chan struct{})
	h := newHarness(t, tools)
	h.post("j1", "pdf", fakePDF)

	var st Status
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if st = h.status(); len(st.Ready) > 0 {
			break
		}
	}
	if st.State != stateRunning || st.Pages == nil || *st.Pages != (PagesStatus{Done: 1, Total: 3}) {
		t.Fatalf("status while page 2 is held = %+v", st)
	}
	want := []string{"t.webp", "s/1/3840.webp", "s/1/1920.webp", "s/1/480.webp"}
	if !slices.Equal(st.Ready, want) {
		t.Fatalf("ready = %v, want %v", st.Ready, want)
	}
	for _, p := range st.Ready {
		code, b, hdr := h.get("/out/" + p)
		if code != 200 || sum(b) != hdr.Get("X-Content-SHA256") || hdr.Get("Content-Type") != "image/webp" {
			t.Errorf("early %s: %d %v", p, code, hdr)
		}
	}
	for _, p := range []string{"/out/manifest.json", "/out/s/2/3840.webp", "/out/doc.pdf", "/out/slides.json"} {
		if code, _, _ := h.get(p); code != 409 {
			t.Errorf("%s before it is published: %d", p, code)
		}
	}
	close(tools.holdPages)
	m := h.mustSucceed(h.wait())
	for _, p := range want {
		if !m.has(p) {
			t.Errorf("the final manifest dropped the early file %s", p)
		}
	}
}

// workerd#7597: a response with no body breaks the next request on a pooled connection.
func TestEveryResponseCarriesABody(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	h.post("j1", "pdf", fakePDF)
	h.mustSucceed(h.wait())
	for _, c := range []struct{ method, path string }{
		{"GET", "/healthz"},
		{"GET", "/job/status"},
		{"GET", "/out/manifest.json"},
		{"GET", "/out/doc.pdf"},
		{"GET", "/out/missing"},
		{"GET", "/out/"},
		{"GET", "/nowhere"},
		{"POST", "/healthz"},
		{"DELETE", "/job/status"},
		{"GET", "/job/start"},
		{"PUT", "/job/input/0"},
		{"PUT", "/job/input/x"},
		{"POST", "/job/start"},
		{"PUT", "/out/doc.pdf"},
	} {
		req := h.do(c.method, c.path, nil)
		b := make([]byte, 1)
		if n, _ := req.Body.Read(b); n == 0 {
			t.Errorf("%s %s -> %d with an empty body", c.method, c.path, req.StatusCode)
		}
	}
	rangeReq, _ := http.NewRequest("GET", h.ts.URL+"/out/doc.pdf", nil)
	rangeReq.Header.Set("Range", "bytes=99999-")
	res, err := http.DefaultClient.Do(rangeReq)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 416 {
		t.Fatalf("range: %d", res.StatusCode)
	}
	if n, _ := res.Body.Read(make([]byte, 1)); n == 0 {
		t.Error("the 416 has no body")
	}
}
