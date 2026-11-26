package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// deckN builds an n-slide pptx in presentation order. notes maps a slide number to its notes, hidden
// lists slides marked show="0", fonts become theme typefaces.
func deckN(n int, notes map[int]string, hidden []int, fonts []string) []byte {
	pres := hdr + `<p:presentation` + nsAttr + `><p:sldIdLst>`
	var presRels [][3]string
	var entries [][2]string
	for i := 1; i <= n; i++ {
		pres += fmt.Sprintf(`<p:sldId id="%d" r:id="rId%d"/>`, 255+i, 10+i)
		presRels = append(presRels, [3]string{fmt.Sprintf("rId%d", 10+i), "slide", fmt.Sprintf("slides/slide%d.xml", i)})
		show := ""
		if slices.Contains(hidden, i) {
			show = ` show="0"`
		}
		entries = append(entries, [2]string{fmt.Sprintf("ppt/slides/slide%d.xml", i), hdr + `<p:sld` + nsAttr + show + `><p:cSld/></p:sld>`})
		if text, ok := notes[i]; ok {
			entries = append(entries,
				[2]string{fmt.Sprintf("ppt/slides/_rels/slide%d.xml.rels", i), rels([3]string{"rId4", "notesSlide", fmt.Sprintf("../notesSlides/notesSlide%d.xml", i)})},
				[2]string{fmt.Sprintf("ppt/notesSlides/notesSlide%d.xml", i), notesXML(shape(`type="body" idx="1"`, run(text)))},
			)
		}
	}
	pres += `</p:sldIdLst></p:presentation>`
	var latin strings.Builder
	for _, f := range fonts {
		latin.WriteString(`<a:latin typeface="` + f + `"/>`)
	}
	entries = append(entries,
		[2]string{"ppt/presentation.xml", pres},
		[2]string{"ppt/_rels/presentation.xml.rels", rels(presRels...)},
		[2]string{"ppt/theme/theme1.xml", `<a:theme xmlns:a="` + nsA + `"><a:minorFont>` + latin.String() + `</a:minorFont></a:theme>`},
	)
	return mkZip(entries...)
}

var cfbMagic = append([]byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}, make([]byte, 64)...)

func TestAnalyzeHiddenSlidesTakeNoPageNumber(t *testing.T) {
	got := analyze(t, deckN(4, map[int]string{3: "three", 4: "four"}, []int{2}, nil)).Notes
	want := []Note{{N: 2, Text: "three"}, {N: 3, Text: "four"}}
	if !slices.Equal(got, want) {
		t.Fatalf("notes = %v, want %v (slide 2 is hidden, so slide 3 is page 2)", got, want)
	}
}

func TestNotesPastThePageCapAreDroppedNotFatal(t *testing.T) {
	tools := newFakeTools(5)
	tools.pptxOut = deckN(5, map[int]string{2: "kept", 5: "past the cap"}, nil, nil)
	h := newHarness(t, tools)
	h.srv.cfg.MaxPages = 3
	h.post("j1", "ppt", cfbMagic)
	m := h.mustSucceed(h.wait())
	if !m.Groups[groupNotes].OK || m.Pages.Total != 5 || m.Pages.Rendered != 3 {
		t.Fatalf("groups %+v pages %+v", m.Groups, m.Pages)
	}
	_, b, _ := h.get("/out/notes.json")
	var nj notesJSON
	json.Unmarshal(b, &nj)
	if len(nj.Notes) != 1 || nj.Notes[0].N != 2 {
		t.Fatalf("notes.json = %s", b)
	}
}

func TestNotesStripControlCharactersExceptNewline(t *testing.T) {
	x := notesXML(shape(`type="body"`, run("a\tb&#9;c\u0085d"), run("e")+`<a:br/>`+run("f&#13;g")))
	if got, want := notesText([]byte(x)), "abcd\ne\nfg"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestCapFonts(t *testing.T) {
	var names []string
	for i := 0; i < 60; i++ {
		names = append(names, fmt.Sprintf("Font %02d", 59-i))
	}
	names = append(names, "Tab\tName", strings.Repeat("x", 150), "\t")
	got := capFonts(names)
	if len(got) != 50 || !slices.IsSorted(got) {
		t.Fatalf("%d names, sorted %v", len(got), slices.IsSorted(got))
	}
	long := capFonts([]string{strings.Repeat("é", 150)})
	if len([]rune(long[0])) != 100 {
		t.Fatalf("a name was cut to %d runes", len([]rune(long[0])))
	}
	if got := capFonts([]string{"Tab\tName", "\t"}); !slices.Equal(got, []string{"TabName"}) {
		t.Fatalf("got %q", got)
	}
}

func TestFontsMissingIsCappedAndSortedThroughTheJob(t *testing.T) {
	var fonts []string
	for i := 0; i < 70; i++ {
		fonts = append(fonts, fmt.Sprintf("Fancy %02d", i))
	}
	tools := newFakeTools(1)
	tools.pptxOut = deckN(1, nil, nil, fonts)
	h := newHarness(t, tools)
	h.post("j1", "ppt", cfbMagic)
	h.mustSucceed(h.wait())
	b, _ := os.ReadFile(h.srv.dir("out", "meta.json")) // not over HTTP: the macOS sandbox cuts sendfile bodies at 512 bytes
	var mj metaJSON
	json.Unmarshal(b, &mj)
	if len(mj.FontsMissing) != 50 || !slices.IsSorted(mj.FontsMissing) {
		t.Fatalf("fontsMissing has %d names", len(mj.FontsMissing))
	}
}

func TestFcListFailureDoesNotCallEveryFontMissing(t *testing.T) {
	tools := newFakeTools(1)
	tools.pptxOut = deckN(1, nil, nil, []string{"Fancy"})
	tools.failOn = "fc-list"
	h := newHarness(t, tools)
	h.post("j1", "ppt", cfbMagic)
	h.mustSucceed(h.wait())
	b, _ := os.ReadFile(h.srv.dir("out", "meta.json")) // not over HTTP: the macOS sandbox cuts sendfile bodies at 512 bytes
	var mj metaJSON
	json.Unmarshal(b, &mj)
	if len(mj.FontsMissing) != 0 {
		t.Fatalf("fontsMissing = %v", mj.FontsMissing)
	}
}

func TestMetaFontsMissingRules(t *testing.T) {
	for name, fonts := range map[string][]string{
		"too many": func() []string {
			var l []string
			for i := 0; i < 51; i++ {
				l = append(l, fmt.Sprintf("F%02d", i))
			}
			return l
		}(),
		"unsorted":  {"b", "a"},
		"too long":  {strings.Repeat("x", 101)},
		"control":   {"a\tb"},
		"empty one": {""},
	} {
		t.Run(name, func(t *testing.T) {
			dir := goodDeckOut(t, 1, defaultWidths)
			put(t, dir, "meta.json", mustJSON(t, metaJSON{V: 1, SHA256: hex64, Kind: kindDeck, FontsMissing: fonts}))
			if _, _, err := validateOutputs(dir, deckWant(1)); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	dir := goodDeckOut(t, 1, defaultWidths)
	put(t, dir, "notes.json", mustJSON(t, notesJSON{V: 1, Notes: []Note{{N: 1, Text: "a\tb"}}}))
	if _, groups, err := validateOutputs(dir, deckWant(1)); err != nil || groups[groupNotes].OK {
		t.Fatalf("a note with a tab passed: %v %+v", err, groups)
	}
}

func TestValidateAnUnreadableTreeIsInternalNotInvalid(t *testing.T) {
	_, _, err := validateOutputs(filepath.Join(t.TempDir(), "missing"), deckWant(1))
	if err == nil || codeOf(err) != errInternal {
		t.Fatalf("err %v code %q", err, codeOf(err))
	}
	if codeOf(invalid("x")) != errOutputInvalid {
		t.Fatal("an invalid tree must be output_invalid")
	}
}

func TestOfficePdfIsRewrittenByPdftocairo(t *testing.T) {
	tools := newFakeTools(1)
	h := newHarness(t, tools)
	h.post("j1", "docx", mkZip([2]string{"word/document.xml", "<w:document/>"}))
	h.mustSucceed(h.wait())
	cairo := tools.called("pdftocairo")
	if len(cairo) != 1 || len(tools.called("soffice")) != 1 {
		t.Fatalf("calls: %v", tools.calls)
	}
	args := cairo[0].args
	if !strings.HasSuffix(args[len(args)-2], filepath.Join("scratch", "lo.pdf")) || !strings.HasSuffix(args[len(args)-1], filepath.Join("out", "doc.pdf")) {
		t.Fatalf("pdftocairo args %v", args)
	}
}

func TestRunCmdKillsAChildTheLeaderLeftBehind(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	_, err := runCmd(context.Background(), cmdSpec{name: "/bin/sh", args: []string{"-c", "sleep 60 & echo $! > " + pidFile}, env: []string{"PATH=/usr/bin:/bin"}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if out, _ := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output(); !strings.ContainsAny(strings.TrimSpace(string(out)), "SRDTI") {
			return // gone, or a zombie waiting to be reaped
		}
	}
	syscall.Kill(pid, syscall.SIGKILL)
	t.Fatalf("the leader's child %d survived", pid)
}

func TestCONV02CapsParallelChunksShareTheInputCap(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	h.srv.cfg.MaxInput = 100
	h.srv.cfg.MaxChunk = 64
	pr, pw := io.Pipe()
	req, _ := http.NewRequest("PUT", h.ts.URL+"/job/input/0", pr)
	done := make(chan *http.Response, 1)
	go func() {
		res, _ := http.DefaultClient.Do(req)
		done <- res
	}()
	pw.Write([]byte("0123456789"))
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		h.srv.mu.Lock()
		n := len(h.srv.uploading)
		h.srv.mu.Unlock()
		if n == 1 {
			break
		}
	}
	// The first chunk may take 64 bytes, so a second of 60 would take the total past 100.
	if res := h.do("PUT", "/job/input/1", bytes.Repeat([]byte("b"), 60)); res.StatusCode != 413 {
		t.Fatalf("second chunk: %d", res.StatusCode)
	}
	pw.Close()
	if res := <-done; res != nil {
		res.Body.Close()
	}
	h.mustFail(h.status(), errTooLarge)
}

func TestStartRefusesASizeOverTheCapAndAnAbsurdChunkCount(t *testing.T) {
	h := newHarness(t, newFakeTools(1))
	h.srv.cfg.MaxInput = 100
	over := startRequest{JobID: "j1", Ext: "pdf", Size: 101, SHA256: hex64, Chunks: 1}
	if res := h.do("POST", "/job/start", mustJSON(t, over)); res.StatusCode != 413 {
		t.Fatalf("size over the cap: %d", res.StatusCode)
	}
	many := startRequest{JobID: "j1", Ext: "pdf", Size: 5, SHA256: hex64, Chunks: 1 << 40}
	start := time.Now()
	if res := h.do("POST", "/job/start", mustJSON(t, many)); res.StatusCode != 400 || time.Since(start) > time.Second {
		t.Fatalf("chunk count: %d after %v", res.StatusCode, time.Since(start))
	}
	if st := h.status(); st.State != stateIdle {
		t.Fatalf("a refused start spent the container: %+v", st)
	}
}

func TestFailedJobWithdrawsPageOne(t *testing.T) {
	tools := newFakeTools(3)
	tools.failLaterPages = true
	h := newHarness(t, tools)
	h.post("j1", "pdf", fakePDF)
	h.mustFail(h.wait(), errConvertFailed)
	if st := h.status(); len(st.Ready) != 0 {
		t.Fatalf("ready after a failure: %v", st.Ready)
	}
	if code, _, _ := h.get("/out/s/1/3840.webp"); code == 200 {
		t.Fatal("page 1 is still served after the job failed")
	}
}

// Every ffmpeg and ffprobe run, the thumbnail included, takes only local files and one named demuxer.
func TestEveryMediaToolRunsWithOnlyFilesAndANamedDemuxer(t *testing.T) {
	for _, ext := range []string{"mov", "webm"} {
		tools := newFakeTools(0)
		h := newHarness(t, tools)
		body := fakeMP4
		if ext == "webm" {
			body = append([]byte{0x1A, 0x45, 0xDF, 0xA3}, make([]byte, 32)...)
		}
		h.post("j1", ext, body)
		h.mustSucceed(h.wait())
		runs := append(tools.called("ffmpeg"), tools.called("ffprobe")...)
		if len(runs) < 4 { // probe, encode, probe of the output, thumbnail
			t.Fatalf("%s: only %d media runs", ext, len(runs))
		}
		for _, r := range runs {
			args := strings.Join(r.args, " ")
			demuxer := after(r.args, "-f")
			if !strings.Contains(args, "-protocol_whitelist file") || (demuxer != "mov" && demuxer != "matroska") {
				t.Errorf("%s: %s lacks -protocol_whitelist file and a named -f: %s", ext, r.name, args)
			}
			if i := slices.Index(r.args, "-i"); r.name == "ffmpeg" && (i < 0 || slices.Index(r.args, "-f") > i) {
				t.Errorf("%s: -f must come before -i: %s", ext, args)
			}
		}
	}
}

func TestVideoIsTheFirstVideoStreamEvenWithoutASize(t *testing.T) {
	p := probe{}
	if err := json.Unmarshal([]byte(`{"streams":[{"codec_type":"video","codec_name":"mjpeg"},{"codec_type":"video","codec_name":"hevc","width":1280,"height":720}]}`), &p); err != nil {
		t.Fatal(err)
	}
	if _, _, codec, ok := p.video(); ok || codec != "mjpeg" {
		t.Fatalf("video() = %q, %v: ffmpeg maps 0:v:0, the first video stream", codec, ok)
	}
}

func TestVideoDemuxerIsForcedByExtensionAndLengthIsBounded(t *testing.T) {
	for ext, want := range map[string]string{"mp4": "-f mov -i", "mov": "-f mov -i", "m4v": "-f mov -i", "webm": "-f matroska -i"} {
		tools := newFakeTools(0)
		h := newHarness(t, tools)
		body := fakeMP4
		if ext == "webm" {
			body = append([]byte{0x1A, 0x45, 0xDF, 0xA3}, make([]byte, 32)...)
		}
		h.post("j1", ext, body)
		h.mustSucceed(h.wait())
		enc := strings.Join(tools.called("ffmpeg")[0].args, " ")
		if !strings.Contains(enc, want) || !strings.Contains(enc, "-t 243") {
			t.Errorf("%s: ffmpeg args %s", ext, enc)
		}
		if probe := strings.Join(tools.called("ffprobe")[0].args, " "); !strings.Contains(probe, strings.TrimSuffix(want, " -i")) {
			t.Errorf("%s: ffprobe args %s", ext, probe)
		}
	}
}
