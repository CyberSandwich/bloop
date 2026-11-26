package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestACopyThatFailsIsEncodedWhenTheClipIsWithinTheEncodeCap(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High", "yuv420p", "aac", "100")
	tools.failOnCopy = true
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustSucceed(h.wait())
	calls := tools.called("ffmpeg")
	if len(calls) < 2 || !strings.Contains(strings.Join(calls[0].args, " "), "-c copy") || !strings.Contains(strings.Join(calls[1].args, " "), "libx264") {
		t.Fatalf("want a failed copy then an encode, got %d ffmpeg runs", len(calls))
	}
}

func TestACopyThatFailsOnAClipOverTheEncodeCapFailsTheJob(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High", "yuv420p", "aac", "3600")
	tools.failOnCopy = true
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustFail(h.wait(), errConvertFailed)
	if n := len(tools.called("ffmpeg")); n != 1 {
		t.Fatalf("%d ffmpeg runs: an hour of video is not encoded as a fallback", n)
	}
}

func TestADurationThatIsNotAPositiveFiniteNumberIsRefused(t *testing.T) {
	for _, d := range []string{"nan", "inf", "-5", "0", "", "N/A"} {
		tools := newFakeTools(0)
		tools.probeIn = h264Probe("High", "yuv420p", "aac", d)
		h := newHarness(t, tools)
		h.post("j1", "mp4", fakeFaststartMP4)
		h.mustFail(h.wait(), errBadMedia)
		if len(tools.called("ffmpeg")) != 0 {
			t.Errorf("duration %q: ffmpeg ran", d)
		}
	}
}

func TestACopyThatRunsToItsLengthSlackFails(t *testing.T) {
	tools := newFakeTools(0)
	tools.probeIn = h264Probe("High", "yuv420p", "aac", "60")
	tools.probeOut = h264Probe("High", "yuv420p", "aac", "70")
	h := newHarness(t, tools)
	h.post("j1", "mp4", fakeFaststartMP4)
	h.mustFail(h.wait(), errOutputInvalid)
}

func TestACopyThatReachesItsSizeLimitFails(t *testing.T) {
	dst := filepath.Join(t.TempDir(), "out.mp4")
	f, err := os.Create(dst)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(copyLimitBytes(100)); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if err := checkCopySize(dst, 100); codeOf(err) != errOutputInvalid {
		t.Fatalf("at the limit: %v", err)
	}
	if err := os.Truncate(dst, copyLimitBytes(100)-1); err != nil {
		t.Fatal(err)
	}
	if err := checkCopySize(dst, 100); err != nil {
		t.Fatalf("under the limit: %v", err)
	}
	if got := copyLimitBytes(1000); got != 1000+100+copySlackBytes {
		t.Fatalf("limit = %d", got)
	}
}
