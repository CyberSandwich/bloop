// bloopconv is the job server inside the conversion container: one job per container lifetime.
// The contract (endpoints, stages, outputs) is in container/README.md.
package main

import (
	"log"
	"math"
	"net/http"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Config holds everything a deployment may tune. Defaults are the plan's limits.
type Config struct {
	Addr         string
	WorkDir      string // writable: uploads, outputs, scratch, the LibreOffice profile
	TmpDir       string
	LORegistry   string // seeded into every fresh LibreOffice profile
	MaxInput     int64
	MaxChunk     int64
	Limits       Limits
	MaxPages     int           // pages beyond this are not rendered; the manifest records the true count
	Widths       []int         // rendered widths, widest first; the smallest is the thumbnail source
	MaxVideoSecs float64       // the longest clip that is re-encoded; a remux has no cap
	VideoRate    float64       // seconds of video the encoder finishes per second of wall time, measured
	VideoWidth   int           // widest video output
	PreviewWidth int           // an HEVC source whose longer side is over this is encoded to fit it first
	VideoFixed   time.Duration // probes and thumbnail, added to every video budget
	MaxImagePx   int64
	Workers      int
	Timeouts     map[string]time.Duration // the video stage's is the ceiling every video budget stays under
}

// defaultVideoRate is the 1080p30 encode rate measured at one CPU on a hard clip (container/README.md, Limits).
const defaultVideoRate = 0.27

// maxWidth keeps the tallest page (aspect 0.25, see minAspect) inside WebP's 16383 px side limit.
const maxWidth = 4095

var stageDefaults = map[string]time.Duration{
	"inspect":   30 * time.Second,
	"convert":   180 * time.Second,
	"rasterize": 500 * time.Second,
	"video":     1440 * time.Second,
	"heic":      60 * time.Second,
}

func loadConfig(getenv func(string) string) Config {
	str := func(key, def string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return def
	}
	num := func(key string, def int64) int64 {
		if n, err := strconv.ParseInt(getenv(key), 10, 64); err == nil && n > 0 {
			return n
		}
		return def
	}
	// count is num for an int field: a value past int32 (the narrowest int) falls back like any bad value.
	count := func(key string, def int) int {
		if n := num(key, int64(def)); n <= math.MaxInt32 {
			return int(n)
		}
		return def
	}
	rate := defaultVideoRate
	if r, err := strconv.ParseFloat(getenv("BLOOP_VIDEO_RATE"), 64); err == nil && r > 0 {
		rate = r
	}
	c := Config{
		Addr:         str("BLOOP_ADDR", ":8080"),
		WorkDir:      str("BLOOP_WORK", "/work"),
		TmpDir:       str("BLOOP_TMP", "/tmp"),
		LORegistry:   str("BLOOP_LO_REGISTRY", "/opt/bloop/lo-registry.xcu"),
		MaxInput:     num("BLOOP_MAX_INPUT", 2<<30),
		MaxChunk:     num("BLOOP_MAX_CHUNK", 64<<20),
		Widths:       parseWidths(getenv("BLOOP_WIDTHS")),
		Limits:       Limits{MaxUnpacked: num("BLOOP_MAX_UNPACKED", 2<<30), MaxEntries: count("BLOOP_MAX_ENTRIES", 20000)},
		MaxPages:     count("BLOOP_MAX_PAGES", 300),
		VideoRate:    rate,
		VideoWidth:   count("BLOOP_VIDEO_WIDTH", 1920),
		PreviewWidth: count("BLOOP_VIDEO_PREVIEW_WIDTH", 1280),
		VideoFixed:   30 * time.Second,
		MaxImagePx:   num("BLOOP_MAX_IMAGE_PIXELS", 100_000_000),
		Workers:      count("BLOOP_WORKERS", min(4, runtime.GOMAXPROCS(0))), // GOMAXPROCS follows the cgroup CPU quota; NumCPU counts the host
		Timeouts:     map[string]time.Duration{},
	}
	for stage, def := range stageDefaults {
		secs := num("BLOOP_TIMEOUT_"+strings.ToUpper(stage), int64(def/time.Second))
		c.Timeouts[stage] = time.Duration(secs) * time.Second
	}
	c.MaxVideoSecs = float64(num("BLOOP_MAX_VIDEO_SECONDS", int64(maxTranscodeSeconds(c.Timeouts["video"], c.VideoFixed, c.VideoRate))))
	return c
}

// parseWidths reads "3840,1920,480". Anything but 1 to 6 strictly descending widths in 1..4095 whose
// smallest fits the thumbnail falls back to the default.
func parseWidths(v string) []int {
	def := slices.Clone(defaultWidths)
	if v == "" {
		return def
	}
	var out []int
	for _, f := range strings.Split(v, ",") {
		w, err := strconv.Atoi(strings.TrimSpace(f))
		if err != nil || w < 1 || w > maxWidth || (len(out) > 0 && w >= out[len(out)-1]) {
			return def
		}
		out = append(out, w)
	}
	if len(out) > 6 || out[len(out)-1] > thumbWidth {
		return def
	}
	return out
}

func main() {
	cfg := loadConfig(os.Getenv)
	srv := newServer(cfg, runCmd)
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	log.Printf("bloopconv listening on %s", cfg.Addr)
	log.Fatal(httpSrv.ListenAndServe())
}
