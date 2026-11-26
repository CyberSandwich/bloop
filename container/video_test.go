package main

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestTranscodeBudgetIsTwiceTheMeasuredTimePlusTheFixedCostUnderTheCeiling(t *testing.T) {
	const fixed, ceiling = 30 * time.Second, 1800 * time.Second
	for _, c := range []struct {
		name    string
		seconds float64
		rate    float64
		want    time.Duration
	}{
		{"60 s at 0.27 is 2 x 222 s + 30 s", 60, 0.27, 30*time.Second + 444444444444*time.Nanosecond},
		{"a faster encoder gets a shorter budget", 60, 1, 150 * time.Second},
		{"a long clip is held to the ceiling", 3600, 0.27, ceiling},
		{"a rate of zero cannot divide: the ceiling", 60, 0, ceiling},
	} {
		if got := transcodeBudget(c.seconds, c.rate, fixed, ceiling); got < c.want-time.Millisecond || got > c.want+time.Millisecond {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestRemuxBudgetGrowsWithSizeUnderTheCeiling(t *testing.T) {
	const fixed, ceiling = 30 * time.Second, 1800 * time.Second
	if got, want := remuxBudget(0, fixed, ceiling), fixed; got != want {
		t.Errorf("empty: %v", got)
	}
	if got, want := remuxBudget(100<<20, fixed, ceiling), fixed+20*time.Second; got != want {
		t.Errorf("100 MiB: %v, want %v", got, want)
	}
	if got, want := remuxBudget(2<<30, fixed, ceiling), fixed+409600*time.Millisecond; got < want-time.Millisecond || got > want+time.Millisecond {
		t.Errorf("2 GiB: %v, want %v", got, want)
	}
	if got := remuxBudget(1<<40, fixed, ceiling); got != ceiling {
		t.Errorf("1 TiB: %v", got)
	}
}

func TestMaxTranscodeSecondsFollowsTheCeiling(t *testing.T) {
	for _, c := range []struct {
		ceiling time.Duration
		rate    float64
		want    float64
	}{
		{1440 * time.Second, 0.27, 190}, // (1440 - 30) x 0.27 / 2 = 190.35
		{900 * time.Second, 0.27, 117},  // 117.45
		{1440 * time.Second, 1, 705},
		{20 * time.Second, 1, 0}, // a ceiling under the fixed cost allows nothing
	} {
		if got := maxTranscodeSeconds(c.ceiling, 30*time.Second, c.rate); got != c.want {
			t.Errorf("%v at %v: %v, want %v", c.ceiling, c.rate, got, c.want)
		}
	}
}

func TestVideoRateAndWidthComeFromTheEnvironment(t *testing.T) {
	env := map[string]string{"BLOOP_VIDEO_RATE": "0.5", "BLOOP_VIDEO_WIDTH": "1280", "BLOOP_TIMEOUT_VIDEO": "1000"}
	c := loadConfig(func(k string) string { return env[k] })
	if c.VideoRate != 0.5 || c.VideoWidth != 1280 || c.MaxVideoSecs != 242 {
		t.Fatalf("rate %v width %d cap %v", c.VideoRate, c.VideoWidth, c.MaxVideoSecs)
	}
	env["BLOOP_MAX_VIDEO_SECONDS"] = "99"
	if c := loadConfig(func(k string) string { return env[k] }); c.MaxVideoSecs != 99 {
		t.Fatalf("an explicit cap wins: %v", c.MaxVideoSecs)
	}
	env["BLOOP_VIDEO_RATE"] = "-3"
	if c := loadConfig(func(k string) string { return env[k] }); c.VideoRate != defaultVideoRate {
		t.Fatalf("a bad rate falls back: %v", c.VideoRate)
	}
}

func writeTemp(t *testing.T, b []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "f.mp4")
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestTopBoxesReadsSizesAndRefusesBrokenLists(t *testing.T) {
	boxes, err := topBoxes(writeTemp(t, mkBoxes("ftyp", "moov", "mdat")))
	if err != nil || len(boxes) != 3 || boxes[0].typ != "ftyp" || boxes[1].typ != "moov" || boxes[2].size != 16 {
		t.Fatalf("boxes = %+v, err %v", boxes, err)
	}
	// A 64-bit size and a size of zero (to the end of the file).
	big := append(mkBoxes("ftyp"), 0, 0, 0, 1, 'm', 'd', 'a', 't', 0, 0, 0, 0, 0, 0, 0, 24, 1, 2, 3, 4, 5, 6, 7, 8)
	if boxes, err := topBoxes(writeTemp(t, big)); err != nil || len(boxes) != 2 || boxes[1].size != 24 {
		t.Fatalf("64-bit size: %+v, err %v", boxes, err)
	}
	toEnd := append(mkBoxes("ftyp"), 0, 0, 0, 0, 'm', 'd', 'a', 't', 9, 9, 9)
	if boxes, err := topBoxes(writeTemp(t, toEnd)); err != nil || len(boxes) != 2 || boxes[1].size != 11 {
		t.Fatalf("size zero: %+v, err %v", boxes, err)
	}
	for name, b := range map[string][]byte{
		"a box past the end of the file": append(mkBoxes("ftyp"), 0, 0, 1, 0, 'm', 'o', 'o', 'v'),
		"a size under its own header":    append(mkBoxes("ftyp"), 0, 0, 0, 4, 'm', 'o', 'o', 'v'),
		"a stray byte":                   append(mkBoxes("ftyp"), 0),
		"a 64-bit size cut short":        append(mkBoxes("ftyp"), 0, 0, 0, 1, 'm', 'd', 'a', 't', 0, 0),
	} {
		if _, err := topBoxes(writeTemp(t, b)); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	if _, err := topBoxes(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Error("a missing file: no error")
	}
}

func TestRemuxableBoxesNeedsOneSmallIndexAndNoFragments(t *testing.T) {
	bx := func(typ string, size int64) box { return box{typ, size} }
	ftyp := bx("ftyp", 24)
	for _, c := range []struct {
		name  string
		boxes []box
		want  bool
	}{
		{"index at the end", []box{ftyp, bx("mdat", 100), bx("moov", 50)}, true},
		{"index at the front", []box{ftyp, bx("moov", 50), bx("mdat", 100)}, true},
		{"empty", nil, false},
		{"no ftyp first", []box{bx("moov", 50), ftyp}, false},
		{"no index", []box{ftyp, bx("mdat", 100)}, false},
		{"two indexes", []box{ftyp, bx("moov", 50), bx("moov", 50)}, false},
		{"fragmented", []box{ftyp, bx("moov", 50), bx("moof", 40), bx("mdat", 100)}, false},
		{"an index over the limit", []box{ftyp, bx("mdat", 100), bx("moov", maxMoovBytes+1)}, false},
		{"an index at the limit", []box{ftyp, bx("mdat", 100), bx("moov", maxMoovBytes)}, true},
	} {
		if got := remuxableBoxes(c.boxes, maxMoovBytes); got != c.want {
			t.Errorf("%s: %v", c.name, got)
		}
	}
}

func TestFaststartedNeedsTheIndexBeforeTheMediaData(t *testing.T) {
	for name, c := range map[string]struct {
		types []string
		want  bool
	}{
		"front":   {[]string{"ftyp", "moov", "mdat"}, true},
		"back":    {[]string{"ftyp", "mdat", "moov"}, false},
		"no mdat": {[]string{"ftyp", "moov"}, true},
		"no moov": {[]string{"ftyp", "mdat"}, false},
	} {
		var boxes []box
		for _, typ := range c.types {
			boxes = append(boxes, box{typ, 16})
		}
		if got := faststarted(boxes); got != c.want {
			t.Errorf("%s: %v", name, got)
		}
	}
}

func probeOf(video, audio string) probe {
	var p probe
	p.Streams = []stream{{CodecType: "video", CodecName: "h264", Profile: "High", PixFmt: "yuv420p", Width: 1920, Height: 1080, Level: 40}}
	if video != "" {
		p.Streams[0].Profile = video
	}
	if audio != "" {
		p.Streams = append(p.Streams, stream{CodecType: "audio", CodecName: audio, Profile: "LC"})
	}
	return p
}

func TestCanRemuxOnlyBrowserSafeH264InAnMP4OrMov(t *testing.T) {
	good := []box{{"ftyp", 24}, {"moov", 50}, {"mdat", 100}}
	ok := func(p probe) bool { return canRemux(p, "mov", 1920, good) }
	if !ok(probeOf("", "aac")) || !ok(probeOf("", "")) {
		t.Fatal("High H.264 with AAC or no audio must remux")
	}
	for _, profile := range []string{"Baseline", "Constrained Baseline", "Main", "High", "Constrained High"} {
		if !ok(probeOf(profile, "aac")) {
			t.Errorf("%s must remux", profile)
		}
	}
	for name, p := range map[string]probe{
		"Extended":              probeOf("Extended", "aac"),
		"High 10":               probeOf("High 10", "aac"),
		"High 4:2:2":            probeOf("High 4:2:2", "aac"),
		"High 4:4:4":            probeOf("High 4:4:4 Predictive", "aac"),
		"opus audio":            probeOf("", "opus"),
		"mp3 audio":             probeOf("", "mp3"),
		"no profile":            probeOf("none", "aac"),
		"hevc":                  {Streams: []stream{{CodecType: "video", CodecName: "hevc", Profile: "Main", PixFmt: "yuv420p", Width: 1280, Height: 720, Level: 40}}},
		"8-bit 4:2:2":           {Streams: []stream{{CodecType: "video", CodecName: "h264", Profile: "High", PixFmt: "yuv422p", Width: 1280, Height: 720, Level: 40}}},
		"10-bit pixels":         {Streams: []stream{{CodecType: "video", CodecName: "h264", Profile: "High", PixFmt: "yuv420p10le", Width: 1280, Height: 720, Level: 40}}},
		"level 6.0":             {Streams: []stream{{CodecType: "video", CodecName: "h264", Profile: "High", PixFmt: "yuv420p", Width: 1280, Height: 720, Level: 60}}},
		"no level":              {Streams: []stream{{CodecType: "video", CodecName: "h264", Profile: "High", PixFmt: "yuv420p", Width: 1280, Height: 720}}},
		"too tall":              {Streams: []stream{{CodecType: "video", CodecName: "h264", Profile: "High", PixFmt: "yuv420p", Width: 1080, Height: 4000, Level: 40}}},
		"xHE-AAC":               {Streams: []stream{{CodecType: "video", CodecName: "h264", Profile: "High", PixFmt: "yuv420p", Width: 1280, Height: 720, Level: 40}, {CodecType: "audio", CodecName: "aac", Profile: "USAC"}}},
		"AAC Main":              {Streams: []stream{{CodecType: "video", CodecName: "h264", Profile: "High", PixFmt: "yuv420p", Width: 1280, Height: 720, Level: 40}, {CodecType: "audio", CodecName: "aac", Profile: "Main"}}},
		"no video":              {Streams: []stream{{CodecType: "audio", CodecName: "aac"}}},
		"wider than the output": {Streams: []stream{{CodecType: "video", CodecName: "h264", Profile: "High", PixFmt: "yuv420p", Width: 3840}}},
	} {
		if ok(p) {
			t.Errorf("%s must be re-encoded, not copied", name)
		}
	}
	// The first video stream decides, as ffmpeg's 0:v:0 does, and so does the first audio stream.
	first := probeOf("", "aac")
	first.Streams = append([]stream{{CodecType: "video", CodecName: "mjpeg", PixFmt: "yuvj420p", Width: 600}}, first.Streams...)
	if ok(first) {
		t.Error("a first video stream that is not H.264 must be re-encoded")
	}
	two := probeOf("", "opus")
	two.Streams = append(two.Streams, stream{CodecType: "audio", CodecName: "aac"})
	if ok(two) {
		t.Error("the first audio stream decides")
	}
	for _, profile := range []string{"HE-AAC", "HE-AACv2"} {
		he := probeOf("", "")
		he.Streams = append(he.Streams, stream{CodecType: "audio", CodecName: "aac", Profile: profile})
		if !ok(he) {
			t.Errorf("%s audio must be copied", profile)
		}
	}
	if canRemux(probeOf("", "aac"), "matroska", 1920, good) {
		t.Error("a matroska input is not copied")
	}
	for name, boxes := range map[string][]box{
		"no index":   {{"ftyp", 24}, {"mdat", 100}},
		"fragmented": {{"ftyp", 24}, {"moov", 50}, {"moof", 40}},
		"huge index": {{"ftyp", 24}, {"mdat", 100}, {"moov", maxMoovBytes + 1}},
		"unreadable": nil,
	} {
		if canRemux(probeOf("", "aac"), "mov", 1920, boxes) {
			t.Errorf("%s: must be re-encoded", name)
		}
	}
	if canRemux(probeOf("", "aac"), "mov", 1280, good) {
		t.Error("a 1080p input must not be copied when the output is 720p wide")
	}
}

func h264Probe(profile, pixFmt, audio, duration string) string {
	a := ""
	if audio != "" {
		a = fmt.Sprintf(`,{"codec_type":"audio","codec_name":%q,"profile":"LC"}`, audio)
	}
	return fmt.Sprintf(`{"streams":[{"codec_type":"video","codec_name":"h264","profile":%q,"pix_fmt":%q,"width":1280,"height":720,"level":40}%s],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":%q}}`,
		profile, pixFmt, a, duration)
}

func TestALongBrowserH264VideoIsCopiedNotEncoded(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High", "yuv420p", "aac", "10800") // three hours
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeFaststartMP4)
	m := h.mustSucceed(h.wait())
	if !m.has("m/0.mp4") || !m.has("t.webp") {
		t.Fatalf("files: %+v", m.Files)
	}
	args := tools.called("ffmpeg")[0].args
	in := filepath.Join(h.srv.cfg.WorkDir, "in", "original.mp4")
	if !slices.Equal(args, remuxArgs(in, h.srv.dir("out", "m", "0.mp4"), int64(len(fakeFaststartMP4)), 10800)) {
		t.Errorf("remux args = %v", args)
	}
	enc := strings.Join(args, " ")
	for _, want := range []string{"-c copy", "-movflags +faststart", "-map 0:v:0", "-map_metadata -1", "-protocol_whitelist file", "-f mov -i",
		"-bsf:v filter_units=remove_types=6", "-t 10810", fmt.Sprintf("-fs %d", copyLimitBytes(int64(len(fakeFaststartMP4))))} {
		if !strings.Contains(enc, want) {
			t.Errorf("remux args lack %q: %s", want, enc)
		}
	}
	for _, banned := range []string{"libx264", "libx265", "-vf", "-crf", "-preset", "-c:v", "-c:a"} {
		if strings.Contains(enc, banned) {
			t.Errorf("remux args hold %q: %s", banned, enc)
		}
	}
}

func TestVideoThatCannotBeCopiedIsEncodedUnderTheCap(t *testing.T) {
	for name, probeIn := range map[string]string{
		"High 10":    h264Probe("High 10", "yuv420p10le", "aac", "100"),
		"High 4:2:2": h264Probe("High 4:2:2", "yuv422p", "aac", "100"),
		"opus audio": h264Probe("High", "yuv420p", "opus", "100"),
	} {
		tools := newFakeTools(0)
		tools.probeIn = probeIn
		h := newHarness(t, tools)
		h.post("j1", "mp4", fakeFaststartMP4)
		h.mustSucceed(h.wait())
		enc := strings.Join(tools.called("ffmpeg")[0].args, " ")
		if !strings.Contains(enc, "libx264") || strings.Contains(enc, "-c copy") || !strings.Contains(enc, "-t 190") {
			t.Errorf("%s: must be encoded under the cap: %s", name, enc)
		}
	}
	// No index to move: the same H.264 is encoded.
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High", "yuv420p", "aac", "100")
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeMP4)
	h.mustSucceed(h.wait())
	if enc := strings.Join(tools.called("ffmpeg")[0].args, " "); !strings.Contains(enc, "libx264") {
		t.Errorf("a file with no index must be encoded: %s", enc)
	}
}

func TestAnEncodeOverTheCapIsRefusedButACopyOfTheSameLengthIsNot(t *testing.T) {
	long := h264Probe("High 10", "yuv420p10le", "aac", "600")
	tools := newFakeTools(0)
	tools.probeIn = long
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustFail(h.wait(), errBadMedia)
	if len(tools.called("ffmpeg")) != 0 {
		t.Fatal("ffmpeg ran on a clip over the encode cap")
	}
	tools = newFakeTools(0)
	tools.probeIn = h264Probe("High", "yuv420p", "aac", "600")
	h = newHarness(t, tools)
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustSucceed(h.wait())
}

func TestAVideoOutputWithItsIndexAtTheEndFails(t *testing.T) {
	if err := checkFaststart(writeTemp(t, mkBoxes("ftyp", "mdat", "moov"))); codeOf(err) != errOutputInvalid {
		t.Fatalf("index at the end: %v", err)
	}
	if err := checkFaststart(writeTemp(t, []byte("not an mp4"))); codeOf(err) != errOutputInvalid {
		t.Fatalf("garbage: %v", err)
	}
	if err := checkFaststart(writeTemp(t, fakeFaststartMP4)); err != nil {
		t.Fatalf("faststarted: %v", err)
	}
}

func TestTheVideoBudgetEndsAJobWithATimeout(t *testing.T) {
	for _, c := range []struct{ name, probe string }{
		{"remux", h264Probe("High", "yuv420p", "aac", "60")},
		{"transcode", h264Probe("High 10", "yuv420p10le", "aac", "60")},
	} {
		tools := newFakeTools(0)
		tools.probeIn = c.probe
		tools.blockOn = "ffmpeg"
		h := newHarness(t, tools)
		h.srv.cfg.VideoFixed = 0
		h.srv.cfg.VideoRate = 1e9 // a budget of nanoseconds, far under the stage ceiling
		h.post("j1", "mp4", fakeFaststartMP4)
		h.mustFail(h.wait(), errTimeout)
	}
}

func TestTheWidthSettingReachesTheScaleFilter(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High 10", "yuv420p10le", "aac", "10")
	h := newHarness(t, tools)
	h.srv.cfg.VideoWidth = 1280
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustSucceed(h.wait())
	if enc := strings.Join(tools.called("ffmpeg")[0].args, " "); !strings.Contains(enc, "min(1280,trunc(iw/2)*2)") {
		t.Errorf("scale filter: %s", enc)
	}
}
