package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

type harness struct {
	t     *testing.T
	srv   *Server
	ts    *httptest.Server
	tools *fakeTools
}

func newHarness(t *testing.T, tools *fakeTools) *harness {
	t.Helper()
	srv := testServer(t, tools)
	ts := httptest.NewServer(srv.routes())
	t.Cleanup(ts.Close)
	return &harness{t: t, srv: srv, ts: ts, tools: tools}
}

func (h *harness) do(method, path string, body []byte) *http.Response {
	h.t.Helper()
	req, _ := http.NewRequest(method, h.ts.URL+path, bytes.NewReader(body))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { res.Body.Close() })
	return res
}

// upload sends body in chunks of chunk bytes (0 = one chunk), then starts the job. It returns the
// first response that is not a success, or the start response.
func (h *harness) upload(id, ext string, body []byte, chunk int) *http.Response {
	h.t.Helper()
	if chunk <= 0 {
		chunk = max(len(body), 1)
	}
	n := 0
	for off := 0; off < len(body) || n == 0; off += chunk {
		res := h.do("PUT", "/job/input/"+itoa(n), body[off:min(off+chunk, len(body))])
		if res.StatusCode != 200 {
			return res
		}
		n++
	}
	return h.start(id, ext, body, n)
}

func (h *harness) start(id, ext string, body []byte, chunks int) *http.Response {
	h.t.Helper()
	req := mustJSON(h.t, startRequest{JobID: id, Ext: ext, Size: int64(len(body)), SHA256: sum(body), Chunks: chunks})
	return h.do("POST", "/job/start", req)
}

func (h *harness) post(id, ext string, body []byte) *http.Response { return h.upload(id, ext, body, 0) }

func (h *harness) get(path string) (int, []byte, http.Header) {
	h.t.Helper()
	res, err := http.Get(h.ts.URL + path)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b, res.Header
}

func (h *harness) status() Status {
	h.t.Helper()
	_, b, _ := h.get("/job/status")
	var st Status
	if err := json.Unmarshal(b, &st); err != nil {
		h.t.Fatalf("status body %q: %v", b, err)
	}
	return st
}

// wait polls until the job leaves the running state.
func (h *harness) wait() Status {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if st := h.status(); st.State == stateDone || st.State == stateFailed {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatal("job did not finish")
	return Status{}
}

func (h *harness) mustFail(st Status, code string) {
	h.t.Helper()
	if st.State != stateFailed || st.Error == nil || *st.Error != code {
		h.t.Fatalf("status = %+v, want failed %q", st, code)
	}
}

func (h *harness) mustSucceed(st Status) Manifest {
	h.t.Helper()
	if st.State != stateDone || st.Error != nil || st.Pct != 100 {
		h.t.Fatalf("status = %+v (error %v)", st, st.Error)
	}
	code, b, _ := h.get("/out/manifest.json")
	if code != 200 {
		h.t.Fatalf("manifest: %d %s", code, b)
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		h.t.Fatal(err)
	}
	return m
}

func (m Manifest) has(path string) bool {
	for _, f := range m.Files {
		if f.Path == path {
			return true
		}
	}
	return false
}

func sum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestHealthz(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	if code, b, _ := h.get("/healthz"); code != 200 || !strings.HasPrefix(string(b), "ok") {
		t.Fatalf("%d %q", code, b)
	}
	if st := h.status(); st.State != stateIdle || st.Error != nil {
		t.Fatalf("fresh status = %+v", st)
	}
}

func TestJobRequestValidation(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	for name, c := range map[string]struct {
		id, ext string
		want    int
	}{
		"no id":      {"", "pptx", 400},
		"id too odd": {"../x", "pptx", 400},
		"long id":    {strings.Repeat("a", 65), "pptx", 400},
		"bad ext":    {"j1", "exe", 415},
		"no ext":     {"j1", "", 415},
	} {
		if res := h.post(c.id, c.ext, []byte("x")); res.StatusCode != c.want {
			t.Errorf("%s: %d, want %d", name, res.StatusCode, c.want)
		}
	}
	for name, body := range map[string]string{
		"not json":      `x`,
		"unknown field": `{"jobId":"j1","ext":"pdf","size":1,"sha256":"` + hex64 + `","chunks":1,"x":1}`,
		"bad sha":       `{"jobId":"j1","ext":"pdf","size":1,"sha256":"ABC","chunks":1}`,
		"no chunks":     `{"jobId":"j1","ext":"pdf","size":1,"sha256":"` + hex64 + `","chunks":0}`,
	} {
		if res := h.do("POST", "/job/start", []byte(body)); res.StatusCode != 400 {
			t.Errorf("%s: %d", name, res.StatusCode)
		}
	}
	for _, p := range []string{"/job/input/-1", "/job/input/x", "/job/input/100000"} {
		if res := h.do("PUT", p, []byte("x")); res.StatusCode != 400 {
			t.Errorf("%s: %d", p, res.StatusCode)
		}
	}
	if st := h.status(); st.State != stateIdle {
		t.Fatalf("a rejected request must not spend the container: %+v", st)
	}
}

func TestCONV07FreshOneJobPerContainer(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	if res := h.post("j1", "pdf", fakePDF); res.StatusCode != 202 {
		t.Fatalf("first job: %d", res.StatusCode)
	}
	h.wait()
	if res := h.post("j2", "pdf", fakePDF); res.StatusCode != 409 {
		t.Fatalf("second job: %d", res.StatusCode)
	}
	if res := h.start("j2", "pdf", fakePDF, 1); res.StatusCode != 409 {
		t.Fatalf("second start: %d", res.StatusCode)
	}
	// A refused upload must not have touched the first job's input.
	b, _ := os.ReadFile(filepath.Join(h.srv.cfg.WorkDir, "in", "original.pdf"))
	if !bytes.Equal(b, fakePDF) {
		t.Fatal("the second upload overwrote the first")
	}
}

func TestOutputsAreNotReadyBeforeTheJobIsDone(t *testing.T) {
	tools := newFakeTools(1)
	tools.blockOn = "pdftocairo"
	h := newHarness(t, tools)
	h.srv.cfg.Timeouts["convert"] = 2 * time.Second
	h.post("j1", "pdf", fakePDF)
	for _, p := range []string{"/out/manifest.json", "/out/doc.pdf"} {
		if code, _, _ := h.get(p); code != 409 {
			t.Errorf("%s: %d", p, code)
		}
	}
	if st := h.status(); st.State != stateRunning {
		t.Fatalf("status = %+v", st)
	}
	h.mustFail(h.wait(), errTimeout)
}

func deckWithNotes() []byte {
	return deck(`<p:cSld/>`, `<p:cSld/>`, map[string]string{"slide1": "Remember the demo"},
		[2]string{"ppt/theme/theme1.xml", `<a:theme xmlns:a="` + nsA + `"><a:minorFont><a:latin typeface="Aptos"/></a:minorFont><a:majorFont><a:latin typeface="Calibri"/></a:majorFont></a:theme>`})
}

func TestDeckEndToEnd(t *testing.T) {
	t.Setenv("BLOOP_SECRET_TEST", "must-not-reach-a-tool")
	tools := newFakeTools(2)
	h := newHarness(t, tools)
	body := deckWithNotes()
	if res := h.post("job-1", "pptx", body); res.StatusCode != 202 {
		t.Fatalf("post: %d", res.StatusCode)
	}
	m := h.mustSucceed(h.wait())
	for _, p := range []string{"doc.pdf", "slides.json", "notes.json", "meta.json", "t.webp",
		"s/1/3840.webp", "s/1/1920.webp", "s/1/480.webp", "s/2/3840.webp", "s/2/1920.webp", "s/2/480.webp"} {
		if !m.has(p) {
			t.Errorf("manifest lacks %s", p)
		}
	}
	if m.JobID != "job-1" || m.Kind != kindDeck || m.V != 1 {
		t.Errorf("manifest header = %+v", m)
	}
	if m.Pages == nil || *m.Pages != (PagesInfo{Total: 2, Rendered: 2}) {
		t.Errorf("manifest pages = %+v", m.Pages)
	}
	for _, g := range []string{groupSlides, groupPDF, groupNotes} {
		if !m.Groups[g].OK {
			t.Errorf("group %s = %+v", g, m.Groups[g])
		}
	}
	if st := h.status(); st.Pages == nil || *st.Pages != (PagesStatus{Done: 2, Total: 2}) || len(st.Ready) != 0 {
		t.Errorf("final status = %+v", st)
	}
	for _, f := range m.Files {
		code, b, hdr := h.get("/out/" + f.Path)
		if code != 200 || sum(b) != f.SHA256 || int64(len(b)) != f.Size || hdr.Get("Content-Type") != f.Type || hdr.Get("X-Content-SHA256") != f.SHA256 {
			t.Errorf("%s: %d, hash or size or type mismatch", f.Path, code)
		}
		if hdr.Get("X-Content-Type-Options") != "nosniff" || hdr.Get("Cache-Control") != "no-store" {
			t.Errorf("%s: headers %v", f.Path, hdr)
		}
	}
	_, slides, _ := h.get("/out/slides.json")
	if strings.Contains(string(slides), "notes") || strings.Contains(string(slides), "Remember") {
		t.Errorf("notes leaked into slides.json: %s", slides)
	}
	var sj slidesJSON
	json.Unmarshal(slides, &sj)
	if len(sj.Pages) != 2 || sj.Pages[0] != (PageDim{N: 1, W: 3840, H: 2160}) {
		t.Errorf("slides.json = %s", slides)
	}
	_, notes, _ := h.get("/out/notes.json")
	if !strings.Contains(string(notes), `"n":2`) || !strings.Contains(string(notes), "Remember the demo") {
		t.Errorf("notes.json = %s", notes)
	}
	_, meta, _ := h.get("/out/meta.json")
	var mj metaJSON
	json.Unmarshal(meta, &mj)
	if mj.SHA256 != sum(body) {
		t.Errorf("meta sha256 %s, want %s", mj.SHA256, sum(body))
	}
	if strings.Join(mj.FontsMissing, "|") != "Aptos" {
		t.Errorf("fontsMissing = %v (Calibri has Carlito)", mj.FontsMissing)
	}
	if code, _, _ := h.get("/out/nope"); code != 404 {
		t.Errorf("unknown output: %d", code)
	}
	for _, p := range []string{"/out/..%2fin%2foriginal.pptx", "/out/%2e%2e/in/original.pptx", "/out/s/../../in/original.pptx"} {
		if code, b, _ := h.get(p); code == 200 {
			t.Errorf("%s served %d bytes", p, len(b))
		}
	}

	// CONV-01 corpus run: tools get a fresh environment and run with no inherited variable.
	for _, c := range tools.calls {
		for _, e := range c.env {
			if strings.HasPrefix(e, "BLOOP_SECRET_TEST") {
				t.Fatalf("%s inherited %s", c.name, e)
			}
		}
		if len(c.env) == 0 {
			t.Errorf("%s ran with an empty environment slice (inherits the parent's)", c.name)
		}
	}
}

func TestCONV03MacrosEveryConversionGetsAFreshLockedProfile(t *testing.T) {
	tools := newFakeTools(1)
	h := newHarness(t, tools)
	h.post("j1", "docx", mkZip([2]string{"word/document.xml", "<w:document/>"}))
	h.mustSucceed(h.wait())
	calls := tools.called("soffice")
	if len(calls) != 1 {
		t.Fatalf("%d soffice calls", len(calls))
	}
	var profile string
	for _, a := range calls[0].args {
		if p, ok := strings.CutPrefix(a, "-env:UserInstallation=file://"); ok {
			profile = p
		}
	}
	if profile == "" || !strings.HasPrefix(profile, h.srv.dir("scratch")) {
		t.Fatalf("profile %q is not a fresh dir under scratch", profile)
	}
	got, err := os.ReadFile(filepath.Join(profile, "user", "registrymodifications.xcu"))
	if err != nil || string(got) != "<oor:items/>" {
		t.Fatalf("the profile was not seeded with the lockdown registry: %q %v", got, err)
	}
	for _, want := range []string{"--headless", "--norestore", "--nolockcheck", "--convert-to"} {
		if !contains(calls[0].args, want) {
			t.Errorf("soffice args lack %s", want)
		}
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestCONV03MacrosFailClosedWithoutTheRegistry(t *testing.T) {
	tools := newFakeTools(1)
	h := newHarness(t, tools)
	h.srv.cfg.LORegistry = filepath.Join(t.TempDir(), "missing.xcu")
	h.post("j1", "docx", mkZip([2]string{"word/document.xml", "<w:document/>"}))
	h.mustFail(h.wait(), errInternal)
	if n := len(tools.called("soffice")); n != 0 {
		t.Fatalf("soffice ran %d times without the macro lockdown", n)
	}
}

func TestDROP12CfbLegacyDeckNotesComeFromTheConvertedPptx(t *testing.T) {
	tools := newFakeTools(2)
	tools.pptxOut = deckWithNotes()
	h := newHarness(t, tools)
	h.post("j1", "ppt", append([]byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}, make([]byte, 64)...))
	h.mustSucceed(h.wait())
	if n := len(tools.called("soffice")); n != 2 {
		t.Fatalf("%d soffice calls, want a pdf and a pptx conversion", n)
	}
	_, notes, _ := h.get("/out/notes.json")
	if !strings.Contains(string(notes), "Remember the demo") {
		t.Fatalf("notes.json = %s", notes)
	}
}

func TestDROP13PdfActiveContentIsRewrittenNotCopied(t *testing.T) {
	tools := newFakeTools(1)
	h := newHarness(t, tools)
	active := append(append([]byte{}, fakePDF...), "<< /S /JavaScript /JS (app.alert) >>"...)
	h.post("j1", "pdf", active)
	m := h.mustSucceed(h.wait())
	if len(tools.called("pdftocairo")) != 1 || len(tools.called("soffice")) != 0 {
		t.Fatalf("a pdf must go through pdftocairo only: %v", tools.calls)
	}
	_, doc, _ := h.get("/out/doc.pdf")
	if bytes.Contains(doc, []byte("/JavaScript")) || !m.has("doc.pdf") {
		t.Fatal("doc.pdf still carries the script")
	}
}

func TestCONV04OutputsAConverterThatEmitsActiveContentWithholdsOnlyThePdf(t *testing.T) {
	tools := newFakeTools(1)
	tools.pdfOut = append(append([]byte{}, fakePDF...), "/Launch"...)
	h := newHarness(t, tools)
	h.post("j1", "docx", mkZip([2]string{"word/document.xml", "<w:document/>"}))
	m := h.mustSucceed(h.wait())
	if m.Groups[groupPDF].OK || !m.Groups[groupSlides].OK || !m.Groups[groupNotes].OK {
		t.Fatalf("groups = %+v", m.Groups)
	}
	if m.has("doc.pdf") || !m.has("s/1/3840.webp") || !m.has("notes.json") {
		t.Fatalf("files = %v", paths(m.Files))
	}
	if code, _, _ := h.get("/out/doc.pdf"); code != 404 {
		t.Fatalf("the withheld pdf was served: %d", code)
	}
}

func TestDROP15MagicBadMagicFailsTheJob(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	h.post("j1", "pptx", []byte("this is plain text, not a zip archive\n"))
	h.mustFail(h.wait(), errBadMagic)
}

func TestCONV02CapsZipBombIsRefused(t *testing.T) {
	tools := newFakeTools(1)
	h := newHarness(t, tools)
	h.srv.cfg.Limits = Limits{MaxUnpacked: 1 << 20, MaxEntries: 100}
	h.post("j1", "pptx", mkZip([2]string{"ppt/media/bomb.bin", strings.Repeat("\x00", 3<<20)}))
	h.mustFail(h.wait(), errBomb)
	if len(tools.called("soffice")) != 0 {
		t.Fatal("a bomb reached LibreOffice")
	}
}

func TestCONV02CapsUploadOverTheLimit(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	h.srv.cfg.MaxInput = 100
	if res := h.post("j1", "pdf", bytes.Repeat([]byte("a"), 1000)); res.StatusCode != 413 {
		t.Fatalf("status %d", res.StatusCode)
	}
	h.mustFail(h.status(), errTooLarge)
}

func TestCONV02CapsChunksTogetherOverTheLimit(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	h.srv.cfg.MaxInput = 100
	for i := range 3 {
		res := h.do("PUT", "/job/input/"+itoa(i), bytes.Repeat([]byte("a"), 40))
		if want := map[bool]int{true: 200, false: 413}[i < 2]; res.StatusCode != want {
			t.Fatalf("chunk %d: %d, want %d", i, res.StatusCode, want)
		}
	}
	h.mustFail(h.status(), errTooLarge)
}

func TestCONV02CapsStageTimeout(t *testing.T) {
	tools := newFakeTools(1)
	tools.blockOn = "soffice"
	h := newHarness(t, tools)
	h.srv.cfg.Timeouts["convert"] = 100 * time.Millisecond
	h.post("j1", "docx", mkZip([2]string{"word/document.xml", "<w:document/>"}))
	h.mustFail(h.wait(), errTimeout)
}

func TestConverterFailureIsReportedWithoutLeakingDetail(t *testing.T) {
	tools := newFakeTools(1)
	tools.failOn = "pdftoppm"
	h := newHarness(t, tools)
	h.post("j1", "pdf", fakePDF)
	st := h.wait()
	h.mustFail(st, errConvertFailed)
	_, b, _ := h.get("/job/status")
	if strings.Contains(string(b), "pdftoppm") {
		t.Fatalf("status leaks the tool: %s", b)
	}
}

func TestVideoJob(t *testing.T) {
	tools := newFakeTools(0)
	h := newHarness(t, tools)
	h.post("j1", "mov", fakeMP4)
	m := h.mustSucceed(h.wait())
	if !m.has("m/0.mp4") || !m.has("t.webp") || !m.has("meta.json") || m.has("doc.pdf") {
		t.Fatalf("files: %+v", m.Files)
	}
	enc := tools.called("ffmpeg")[0]
	args := strings.Join(enc.args, " ")
	for _, want := range []string{"libx264", "-crf 23", "+faststart", "-protocol_whitelist file", "-map_metadata -1"} {
		if !strings.Contains(args, want) {
			t.Errorf("ffmpeg args lack %q: %s", want, args)
		}
	}
	_, meta, _ := h.get("/out/meta.json")
	var mj metaJSON
	json.Unmarshal(meta, &mj)
	if mj.Video == nil || mj.Video.W != 1280 || mj.Video.DurationMs != 3000 {
		t.Errorf("meta = %s", meta)
	}
}

func TestVideoWithoutAVideoStreamIsRefused(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = `{"streams":[{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"3"}}`
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeMP4)
	h.mustFail(h.wait(), errBadMedia)
	if len(tools.called("ffmpeg")) != 0 {
		t.Fatal("ffmpeg ran on a file with no video")
	}
}

func TestVideoThatDoesNotComeOutAsH264IsRefused(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeOut = strings.ReplaceAll(tools.probeOut, "h264", "hevc")
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeMP4)
	h.mustFail(h.wait(), errOutputInvalid)
}

func TestImageJob(t *testing.T) {
	tools := newFakeTools(0)
	h := newHarness(t, tools)
	heic := append([]byte{0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'h', 'e', 'i', 'c', 0, 0, 0, 0, 'm', 'i', 'f', '1', 'h', 'e', 'i', 'c'}, make([]byte, 32)...)
	h.post("j1", "heic", heic)
	m := h.mustSucceed(h.wait())
	if !m.has("i/1920.jpg") || !m.has("t.webp") {
		t.Fatalf("files: %+v", m.Files)
	}
	for _, c := range tools.called("vips") {
		if !strings.Contains(strings.Join(c.args, " "), "keep=none") {
			t.Errorf("metadata not stripped: %v", c.args)
		}
	}
}

func TestImageOverThePixelCapIsRefused(t *testing.T) {
	h := newHarness(t, newFakeTools(0))
	h.srv.cfg.MaxImagePx = 1000
	heic := append([]byte{0, 0, 0, 0x14, 'f', 't', 'y', 'p', 'h', 'e', 'i', 'c', 0, 0, 0, 0, 'm', 'i', 'f', '1'}, make([]byte, 32)...)
	h.post("j1", "heic", heic)
	h.mustFail(h.wait(), errBadMedia)
}

func TestRunCmdKillsTheWholeProcessGroupAtTheDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := runCmd(ctx, cmdSpec{name: "/bin/sh", args: []string{"-c", "sleep 60 & wait"}, env: []string{"PATH=/usr/bin:/bin"}})
	if err != context.DeadlineExceeded {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("took %v: the grandchild kept the pipe open", time.Since(start))
	}
}

func TestRunCmdCapsCapturedOutputAndReportsStderr(t *testing.T) {
	out, err := runCmd(context.Background(), cmdSpec{name: "/bin/sh", args: []string{"-c", "head -c 9000000 /dev/zero"}, env: []string{"PATH=/usr/bin:/bin"}})
	if err != nil || len(out) != maxCapturedOutput {
		t.Fatalf("len %d, err %v", len(out), err)
	}
	_, err = runCmd(context.Background(), cmdSpec{name: "/bin/sh", args: []string{"-c", "echo broken >&2; exit 3"}, env: []string{"PATH=/usr/bin:/bin"}})
	if err == nil || !strings.Contains(err.Error(), "broken") {
		t.Fatalf("err = %v", err)
	}
}

func TestRunCmdUsesOnlyTheGivenEnvironment(t *testing.T) {
	t.Setenv("BLOOP_SECRET_TEST", "x")
	out, err := runCmd(context.Background(), cmdSpec{name: "/usr/bin/env", env: []string{"ONLY=this"}})
	if err != nil || strings.TrimSpace(string(out)) != "ONLY=this" {
		t.Fatalf("env = %q, %v", out, err)
	}
}

func TestLoadConfigDefaultsAndOverrides(t *testing.T) {
	c := loadConfig(func(string) string { return "" })
	if c.MaxPages != 300 || c.MaxChunk != 64<<20 || !slices.Equal(c.Widths, []int{3840, 1920, 480}) || c.Limits.MaxUnpacked != 2<<30 || c.Timeouts["convert"] != 180*time.Second ||
		c.Timeouts["rasterize"] != 500*time.Second || c.Timeouts["video"] != 1440*time.Second || c.MaxVideoSecs != 190 || c.VideoWidth != 1920 ||
		c.Timeouts["inspect"] != 30*time.Second || c.Timeouts["heic"] != 60*time.Second || c.Addr != ":8080" {
		t.Fatalf("defaults = %+v", c)
	}
	c = loadConfig(func(k string) string {
		return map[string]string{"BLOOP_TIMEOUT_CONVERT": "7", "BLOOP_MAX_PAGES": "5", "BLOOP_MAX_INPUT": "bad"}[k]
	})
	if c.Timeouts["convert"] != 7*time.Second || c.MaxPages != 5 || c.MaxInput != 2<<30 {
		t.Fatalf("overrides = %+v", c)
	}
}

func TestLoadConfigIntFieldsPastInt32FallBack(t *testing.T) {
	over := map[string]string{
		"BLOOP_MAX_ENTRIES":         "2147483648",          // int32 max + 1
		"BLOOP_MAX_PAGES":           "4294967596",          // 2^32 + 300: a 32-bit int would wrap it to 300
		"BLOOP_VIDEO_WIDTH":         "9223372036854775808", // past int64: ParseInt fails
		"BLOOP_VIDEO_PREVIEW_WIDTH": "2147483648",
		"BLOOP_WORKERS":             "-1",
		"BLOOP_MAX_IMAGE_PIXELS":    "4294967296", // an int64 field keeps a value past int32
	}
	c := loadConfig(func(k string) string { return over[k] })
	if c.Limits.MaxEntries != 20000 || c.MaxPages != 300 || c.VideoWidth != 1920 || c.PreviewWidth != 1280 || c.Workers < 1 || c.Workers > 4 ||
		c.MaxImagePx != 4294967296 {
		t.Fatalf("config = %+v", c)
	}
	c = loadConfig(func(k string) string { return map[string]string{"BLOOP_MAX_PAGES": "2147483647"}[k] })
	if c.MaxPages != 2147483647 {
		t.Fatalf("MaxPages at int32 max = %d", c.MaxPages)
	}
}

func TestWithinRefusesNamesThatLeaveTheDir(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"", "..", "../x", "a/../../x", "/etc/passwd", "original./../../x"} {
		if p, err := within(dir, name); !errors.Is(err, errNotLocal) {
			t.Errorf("within(%q) = %q, %v; want errNotLocal", name, p, err)
		}
	}
	if p, err := within(dir, "original.pdf"); err != nil || p != filepath.Join(dir, "original.pdf") {
		t.Fatalf("within(original.pdf) = %q, %v", p, err)
	}
	cfg := Config{WorkDir: dir}
	if _, err := inputPath(cfg, "/../../etc/passwd"); !errors.Is(err, errNotLocal) {
		t.Fatalf("inputPath with a climbing ext: %v", err)
	}
	if p, err := inputPath(cfg, "pdf"); err != nil || p != filepath.Join(dir, "in", "original.pdf") {
		t.Fatalf("inputPath(pdf) = %q, %v", p, err)
	}
}
