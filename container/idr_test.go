package main

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestFirstSliceIsIDRReadsTheFirstPictureSliceOfAnnexB(t *testing.T) {
	for name, c := range map[string]struct {
		au   []byte
		want bool
	}{
		"IDR slice":                      {annexB(nalIDR), true},
		"non-IDR slice (intra refresh)":  {annexB(nalNonIDR), false},
		"slice data partition A":         {annexB(0x42), false},
		"empty":                          {nil, false},
		"parameter sets and SEI only":    {annexB(nalIDR)[:19], false},
		"three-byte start code, IDR":     {[]byte{0, 0, 1, nalIDR, 9}, true},
		"IDR after a non-picture NAL":    {[]byte{0, 0, 1, 0x09, 0xf0, 0, 0, 1, nalIDR, 9}, true},
		"non-IDR first, IDR after it":    {[]byte{0, 0, 1, nalNonIDR, 9, 0, 0, 1, nalIDR, 9}, false},
		"start code cut off at the end":  {[]byte{0, 0, 1}, false},
		"emulation bytes inside a slice": {[]byte{0, 0, 1, nalNonIDR, 0, 0, 3, 1}, false},
	} {
		if got := firstSliceIsIDR(c.au); got != c.want {
			t.Errorf("%s: got %v, want %v", name, got, c.want)
		}
	}
}

func TestACopyThatDoesNotStartOnAnIDRIsEncodedInstead(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High", "yuv420p", "aac", "100")
	tools.firstAU = annexB(nalNonIDR)
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustSucceed(h.wait())
	calls := tools.called("ffmpeg")
	if len(calls) != 1 {
		t.Fatalf("%d ffmpeg runs, want one encode", len(calls))
	}
	if enc := strings.Join(calls[0].args, " "); !strings.Contains(enc, "libx264") || strings.Contains(enc, "-c copy") {
		t.Fatalf("a stream with no IDR must be encoded: %s", enc)
	}
}

func TestANonIDRStreamOverTheEncodeCapIsRefused(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High", "yuv420p", "aac", "600")
	tools.firstAU = annexB(nalNonIDR)
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustFail(h.wait(), errBadMedia)
	if n := len(tools.called("ffmpeg")); n != 0 {
		t.Fatalf("%d ffmpeg runs on a clip that can be neither copied nor encoded", n)
	}
}

func TestTheIDRReadIsOneAccessUnitFromTheFirstVideoStreamWithTheInputRestricted(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High", "yuv420p", "aac", "100")
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustSucceed(h.wait())
	probes := tools.calledWhere("ffmpeg", isIDRProbe)
	if len(probes) != 1 {
		t.Fatalf("%d IDR reads, want one", len(probes))
	}
	enc := strings.Join(probes[0].args, " ")
	for _, want := range []string{"-protocol_whitelist file", "-f mov -i", "-map 0:v:0", "-frames:v 1", "-bsf:v h264_mp4toannexb", "-f h264 pipe:1"} {
		if !strings.Contains(enc, want) {
			t.Errorf("IDR read lacks %q: %s", want, enc)
		}
	}
	if slices.Contains(probes[0].args, "-y") {
		t.Error("the IDR read writes no file")
	}
}

func TestAStreamThatCannotBeCopiedIsNotReadForAnIDR(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High 10", "yuv420p10le", "aac", "100")
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustSucceed(h.wait())
	if n := len(tools.calledWhere("ffmpeg", isIDRProbe)); n != 0 {
		t.Fatalf("%d IDR reads for a stream that is encoded anyway", n)
	}
}

func TestTheFallbackEncodeGetsOnlyTheTimeTheStageHasLeft(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High", "yuv420p", "aac", "10")
	tools.failOnCopy = true
	h := newHarness(t, tools)
	h.srv.cfg.Timeouts["video"] = 100 * time.Second
	h.srv.cfg.VideoFixed = 30 * time.Second
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustSucceed(h.wait())
	// The encode's own budget (30 s + 2 x 10 s / 0.27) is over 100 s, so only the 70 s left after the reserve bounds it.
	if left := tools.encodeLeft; left <= 0 || left > 70*time.Second {
		t.Fatalf("fallback encode had %v, want at most the 70 s left of the stage after its reserve", left)
	}
}

func TestACopyThatFailsWithNoTimeLeftForAnEncodeFailsTheJob(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High", "yuv420p", "aac", "10")
	tools.failOnCopy = true
	h := newHarness(t, tools)
	h.srv.cfg.Timeouts["video"] = 30 * time.Second
	h.srv.cfg.VideoFixed = 30 * time.Second
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustFail(h.wait(), errConvertFailed)
	if n := len(tools.called("ffmpeg")); n != 1 {
		t.Fatalf("%d ffmpeg runs, want the failed copy alone", n)
	}
}

func TestStageTimeLeftKeepsTheReserve(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	left, ok := stageTimeLeft(ctx, 20*time.Second)
	if !ok || left <= 30*time.Second || left > 40*time.Second {
		t.Fatalf("left = %v, ok = %v: want about 40 s", left, ok)
	}
	if _, ok := stageTimeLeft(ctx, 2*time.Minute); ok {
		t.Fatal("a reserve over the whole stage leaves nothing")
	}
	if left, ok := stageTimeLeft(context.Background(), time.Hour); !ok || left <= 24*time.Hour {
		t.Fatalf("a context with no deadline has all the time there is: %v %v", left, ok)
	}
}
