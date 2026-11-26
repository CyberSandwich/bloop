// bloopconv is the job server inside the conversion container: one job per container lifetime.
// The contract (endpoints, stages, outputs) is in container/README.md.
package main

import (
	"log"
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
	MaxPages     int   // pages beyond this are not rendered; the manifest records the true count
	Widths       []int // rendered widths, widest first; the smallest is the thumbnail source
	MaxVideoSecs float64
	MaxImagePx   int64
	Workers      int
	Timeouts     map[string]time.Duration
}

// maxWidth keeps the tallest page (aspect 0.25, see minAspect) inside WebP's 16383 px side limit.
const maxWidth = 4095

var stageDefaults = map[string]time.Duration{
	"inspect":   30 * time.Second,
	"convert":   180 * time.Second,
	"rasterize": 1500 * time.Second,
	"video":     900 * time.Second,
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
	c := Config{
		Addr:         str("BLOOP_ADDR", ":8080"),
		WorkDir:      str("BLOOP_WORK", "/work"),
		TmpDir:       str("BLOOP_TMP", "/tmp"),
		LORegistry:   str("BLOOP_LO_REGISTRY", "/opt/bloop/lo-registry.xcu"),
		MaxInput:     num("BLOOP_MAX_INPUT", 2<<30),
		MaxChunk:     num("BLOOP_MAX_CHUNK", 64<<20),
		Widths:       parseWidths(getenv("BLOOP_WIDTHS")),
		Limits:       Limits{MaxUnpacked: num("BLOOP_MAX_UNPACKED", 2<<30), MaxEntries: int(num("BLOOP_MAX_ENTRIES", 20000))},
		MaxPages:     int(num("BLOOP_MAX_PAGES", 300)),
		MaxVideoSecs: float64(num("BLOOP_MAX_VIDEO_SECONDS", 4*3600)),
		MaxImagePx:   num("BLOOP_MAX_IMAGE_PIXELS", 100_000_000),
		Workers:      int(num("BLOOP_WORKERS", int64(min(4, runtime.GOMAXPROCS(0))))), // GOMAXPROCS follows the cgroup CPU quota; NumCPU counts the host
		Timeouts:     map[string]time.Duration{},
	}
	for stage, def := range stageDefaults {
		secs := num("BLOOP_TIMEOUT_"+strings.ToUpper(stage), int64(def/time.Second))
		c.Timeouts[stage] = time.Duration(secs) * time.Second
	}
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
