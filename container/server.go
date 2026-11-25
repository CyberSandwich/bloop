package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Job states in /job/status.
const (
	stateIdle    = "idle"
	stateRunning = "running"
	stateDone    = "done"
	stateFailed  = "failed"
)

// Status is the body of GET /job/status. Error is a code from kinds.go, null unless failed.
type Status struct {
	State string  `json:"state"`
	Stage string  `json:"stage"`
	Pct   int     `json:"pct"`
	Error *string `json:"error"`
}

// Manifest is the body of GET /out/manifest.json.
type Manifest struct {
	V     int       `json:"v"`
	JobID string    `json:"jobId"`
	Kind  string    `json:"kind"`
	Files []OutFile `json:"files"`
}

// jobInfo is what the upload handler hands to the pipeline.
type jobInfo struct {
	id     string
	ext    string
	kind   string
	sha256 string
}

// Server runs at most one job in its lifetime.
type Server struct {
	cfg Config
	run runner

	mu       sync.Mutex
	started  bool
	status   Status
	manifest *Manifest
	byPath   map[string]OutFile

	pageCount int // set by the pipeline goroutine before it validates
}

func newServer(cfg Config, run runner) *Server {
	return &Server{cfg: cfg, run: run, status: Status{State: stateIdle}}
}

var reJobID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("POST /job", s.handleJob)
	mux.HandleFunc("GET /job/status", s.handleStatus)
	mux.HandleFunc("GET /out/manifest.json", s.handleManifest)
	mux.HandleFunc("GET /out/{path...}", s.handleOut)
	return mux
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func apiError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (s *Server) snapshot() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *Server) set(stage string, pct int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.Stage = stage
	s.status.Pct = max(s.status.Pct, min(pct, 99))
}

func (s *Server) fail(code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.State = stateFailed
	s.status.Error = &code
}

func (s *Server) finish(m *Manifest) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.manifest = m
	s.byPath = make(map[string]OutFile, len(m.Files))
	for _, f := range m.Files {
		s.byPath[f.Path] = f
	}
	s.status = Status{State: stateDone, Stage: "done", Pct: 100}
}

// handleJob streams the body to disk (hashing as it goes), then starts the pipeline.
// A second POST is refused whatever the first one did: a container is spent after one job.
func (s *Server) handleJob(w http.ResponseWriter, r *http.Request) {
	id := r.Header.Get("X-Job-Id")
	ext := strings.ToLower(strings.TrimPrefix(r.Header.Get("X-Job-Ext"), "."))
	kind, known := kindByExt[ext]
	switch {
	case !reJobID.MatchString(id):
		apiError(w, http.StatusBadRequest, "bad_job_id")
		return
	case !known:
		apiError(w, http.StatusUnsupportedMediaType, "unsupported_ext")
		return
	}
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		apiError(w, http.StatusConflict, "job_already_started")
		return
	}
	s.started = true
	s.status = Status{State: stateRunning, Stage: "upload"}
	s.mu.Unlock()

	sum, err := s.receive(w, r, ext)
	if err != nil {
		code, status := errUpload, http.StatusBadRequest
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			code, status = errTooLarge, http.StatusRequestEntityTooLarge
		}
		log.Printf("job %s: upload: %v", id, err)
		s.fail(code)
		apiError(w, status, code)
		return
	}
	job := jobInfo{id: id, ext: ext, kind: kind, sha256: sum}
	go s.process(job)
	writeJSON(w, http.StatusAccepted, map[string]string{"state": stateRunning})
}

// receive writes the body to <work>/in/original.<ext> and returns its SHA-256.
func (s *Server) receive(w http.ResponseWriter, r *http.Request, ext string) (string, error) {
	rc := http.NewResponseController(w)
	rc.SetReadDeadline(time.Now().Add(30 * time.Minute))
	if err := os.MkdirAll(filepath.Join(s.cfg.WorkDir, "in"), 0o700); err != nil {
		return "", err
	}
	f, err := os.OpenFile(inputPath(s.cfg, ext), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	body := http.MaxBytesReader(w, r.Body, s.cfg.MaxInput)
	if _, err := io.Copy(io.MultiWriter(f, h), body); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), f.Close()
}

func inputPath(cfg Config, ext string) string {
	return filepath.Join(cfg.WorkDir, "in", "original."+ext)
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.snapshot())
}

func (s *Server) handleManifest(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	m := s.manifest
	s.mu.Unlock()
	if m == nil {
		apiError(w, http.StatusConflict, "not_ready")
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// handleOut serves one manifest entry. Only paths the manifest lists exist; nothing is joined from the URL.
func (s *Server) handleOut(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	entry, ok := s.byPath[r.PathValue("path")]
	ready := s.manifest != nil
	s.mu.Unlock()
	if !ready {
		apiError(w, http.StatusConflict, "not_ready")
		return
	}
	if !ok {
		apiError(w, http.StatusNotFound, "not_found")
		return
	}
	f, err := os.Open(filepath.Join(s.cfg.WorkDir, "out", filepath.FromSlash(entry.Path)))
	if err != nil {
		apiError(w, http.StatusInternalServerError, errInternal)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", entry.Type)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Content-SHA256", entry.SHA256)
	http.ServeContent(w, r, "", time.Time{}, f)
}
