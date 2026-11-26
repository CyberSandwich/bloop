package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"time"
)

const (
	// maxMoovBytes bounds the index a remux has to move to the front: faststart rewrites the whole file, and a
	// larger moov atom is a file we would rather re-encode than trust.
	maxMoovBytes = 64 << 20
	maxBoxes     = 10000 // top-level boxes read before a file is refused

	// remuxBytesPerSec is the slowest copy rate the remux budget assumes, a fraction of what a disk gives.
	remuxBytesPerSec = 10 << 20
)

// box is one top-level ISO base media box.
type box struct {
	typ  string
	size int64
}

var errNotMP4 = errors.New("not a well-formed top-level box list")

// topBoxes lists the top-level boxes of an mp4 or mov file. A box whose size runs past the file, a size under its
// own header, or more than maxBoxes boxes is an error.
func topBoxes(path string) ([]box, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	var out []box
	for pos := int64(0); pos < st.Size(); {
		if len(out) == maxBoxes {
			return nil, errNotMP4
		}
		var hdr [16]byte
		n, err := f.ReadAt(hdr[:], pos)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		if n < 8 {
			return nil, errNotMP4
		}
		size, headLen := int64(binary.BigEndian.Uint32(hdr[0:4])), int64(8)
		switch size {
		case 0: // the box runs to the end of the file
			size = st.Size() - pos
		case 1: // a 64-bit size follows the type
			if n < 16 {
				return nil, errNotMP4
			}
			u := binary.BigEndian.Uint64(hdr[8:16])
			if u > math.MaxInt64 {
				return nil, errNotMP4
			}
			size, headLen = int64(u), 16
		}
		if size < headLen || size > st.Size()-pos {
			return nil, errNotMP4
		}
		out = append(out, box{typ: string(hdr[4:8]), size: size})
		pos += size
	}
	return out, nil
}

// remuxableBoxes reports whether a file's boxes allow a remux to faststart: an ftyp first, one moov within
// maxMoov, and no fragments (a fragmented file has no single index to move).
func remuxableBoxes(boxes []box, maxMoov int64) bool {
	if len(boxes) == 0 || boxes[0].typ != "ftyp" {
		return false
	}
	moovs := 0
	for _, b := range boxes {
		switch b.typ {
		case "moof":
			return false
		case "moov":
			moovs++
			if b.size > maxMoov {
				return false
			}
		}
	}
	return moovs == 1
}

// faststarted reports whether the index comes before the media data, so a browser can start playing at once.
func faststarted(boxes []box) bool {
	moov, mdat := -1, -1
	for i, b := range boxes {
		switch b.typ {
		case "moov":
			moov = i
		case "mdat":
			if mdat < 0 {
				mdat = i
			}
		}
	}
	return moov >= 0 && (mdat < 0 || moov < mdat)
}

// stream is one ffprobe stream.
type stream struct {
	CodecType string `json:"codec_type"`
	CodecName string `json:"codec_name"`
	Profile   string `json:"profile"`
	PixFmt    string `json:"pix_fmt"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Level     int    `json:"level"` // H.264 level times ten: 52 is 5.2
}

// maxCopyLevel is the highest H.264 level that is copied: 5.2 is 4K at 60 fps, the most a browser is sure to decode.
const maxCopyLevel = 52

// copySlack is what a copy may exceed the probed length and the input size by before it is stopped: a few
// seconds of rounding in the header, and the container overhead of a rewritten index.
const copySlackSeconds = 10
const copySlackBytes = 16 << 20

// first returns the first stream of a kind, the one ffmpeg maps as 0:v:0 or 0:a:0.
func (p probe) first(kind string) (stream, bool) {
	for _, st := range p.Streams {
		if st.CodecType == kind {
			return st, true
		}
	}
	return stream{}, false
}

// browserH264 is the H.264 every browser plays: 8-bit 4:2:0 in Baseline, Main or High, at a level up to 5.2. High 10,
// the 4:2:2 and 4:4:4 profiles and Extended are not.
func browserH264(v stream) bool {
	switch v.Profile {
	case "Baseline", "Constrained Baseline", "Main", "High", "Constrained High":
		return v.CodecName == "h264" && v.PixFmt == "yuv420p" && v.Level > 0 && v.Level <= maxCopyLevel
	}
	return false
}

// browserAAC is the AAC every browser plays: low complexity, HE-AAC and HE-AACv2.
func browserAAC(a stream) bool {
	return a.CodecName == "aac" && (a.Profile == "LC" || a.Profile == "HE-AAC" || a.Profile == "HE-AACv2")
}

// canRemux reports whether the upload can be copied into an mp4 instead of re-encoded: an mov or mp4 container
// holding browser H.264 no wider and no taller than the output width, and browser AAC or no audio.
func canRemux(p probe, demuxer string, maxWidth int, boxes []box) bool {
	if demuxer != "mov" || !remuxableBoxes(boxes, maxMoovBytes) {
		return false
	}
	v, ok := p.first("video")
	if !ok || !browserH264(v) || v.Width <= 0 || v.Width > maxWidth || v.Height <= 0 || v.Height > maxWidth {
		return false
	}
	if a, ok := p.first("audio"); ok && !browserAAC(a) {
		return false
	}
	return true
}

// transcodeBudget is how long an encode of `seconds` of video may run: twice what the measured rate says it takes,
// plus the fixed cost of the probes and the thumbnail, never more than the ceiling.
func transcodeBudget(seconds, rate float64, fixed, ceiling time.Duration) time.Duration {
	if rate <= 0 {
		return ceiling
	}
	d := fixed + time.Duration(2*seconds/rate*float64(time.Second))
	return min(d, ceiling)
}

// remuxBudget is how long a copy of `size` bytes may run: the slowest copy rate, doubled, plus the fixed cost.
func remuxBudget(size int64, fixed, ceiling time.Duration) time.Duration {
	d := fixed + time.Duration(2*float64(size)/remuxBytesPerSec*float64(time.Second))
	return min(d, ceiling)
}

// maxTranscodeSeconds is the longest clip whose transcodeBudget fits under the ceiling: (ceiling - fixed) x rate / 2,
// to the whole second.
func maxTranscodeSeconds(ceiling, fixed time.Duration, rate float64) float64 {
	return math.Max(0, math.Floor((ceiling-fixed).Seconds()*rate/2+1e-9))
}

// copyLimitBytes is the most a copy of a file of `size` bytes may write: the input plus a tenth and the slack.
func copyLimitBytes(size int64) int64 { return size + size/10 + copySlackBytes }

// checkCopySize fails a copy that ran into its size limit (ffmpeg stops there with a file cut short, no error).
func checkCopySize(dst string, size int64) error {
	st, err := os.Stat(dst)
	if err != nil {
		return failed(errInternal, err)
	}
	if st.Size() >= copyLimitBytes(size) {
		return failed(errOutputInvalid, fmt.Errorf("copy of %d bytes reached its %d byte limit", size, copyLimitBytes(size)))
	}
	return nil
}

// checkFaststart fails a finished mp4 whose index is not at the front.
func checkFaststart(path string) error {
	boxes, err := topBoxes(path)
	if err != nil {
		return failed(errOutputInvalid, err)
	}
	if !faststarted(boxes) {
		return failed(errOutputInvalid, fmt.Errorf("%s: moov is not before mdat", path))
	}
	return nil
}
