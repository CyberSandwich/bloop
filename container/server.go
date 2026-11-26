package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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

const (
	maxChunkIndex = 100_000
	maxStartBody  = 4 << 10
)

// PagesStatus is render progress: pages finished out of the pages that will be rendered.
type PagesStatus struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

// Status is the body of GET /job/status. Error is a code from kinds.go, null unless failed.
// Ready lists output paths fetchable before the job is done (page 1 of a document).
type Status struct {
	State string       `json:"state"`
	Stage string       `json:"stage"`
	Pct   int          `json:"pct"`
	Error *string      `json:"error"`
	Pages *PagesStatus `json:"pages"`
	Ready []string     `json:"ready"`
}

// PagesInfo says how many pages the document has and how many were rendered.
type PagesInfo struct {
	Total    int `json:"total"`
	Rendered int `json:"rendered"`
}

// Manifest is the body of GET /out/manifest.json. Files holds only the groups that passed.
type Manifest struct {
	V      int                    `json:"v"`
	JobID  string                 `json:"jobId"`
	Kind   string                 `json:"kind"`
	Pages  *PagesInfo             `json:"pages"`
	Groups map[string]GroupResult `json:"groups"`
	Files  []OutFile              `json:"files"`
}

// startRequest is the body of POST /job/start.
type startRequest struct {
	JobID  string `json:"jobId"`
	Ext    string `json:"ext"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Chunks int    `json:"chunks"`
}

// jobInfo is what the start handler hands to the pipeline.
type jobInfo struct {
	id     string
	ext    string
	kind   string
	sha256 string
	input  string // the assembled upload, confined to WorkDir/in by inputPath
}

// Server runs at most one job in its lifetime.
type Server struct {
	cfg Config
	run runner

	mu         sync.Mutex
	starting   bool
	started    bool
	chunks     map[int]int64 // received chunk sizes by index
	uploading  map[int]int64 // chunks being received, and the bytes each may use
	status     Status
	manifest   *Manifest
	preview    *Manifest // a video's 720p listing while its full encode runs
	previewDir string    // where those files are served from
	byPath     map[string]OutFile

	pages *PagesInfo // written by the pipeline goroutine only, read after it validates
}

func newServer(cfg Config, run runner) *Server {
	return &Server{
		cfg: cfg, run: run,
		chunks: map[int]int64{}, uploading: map[int]int64{},
		byPath: map[string]OutFile{},
		status: Status{State: stateIdle, Ready: []string{}},
	}
}

var (
	reJobID  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	reSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("PUT /job/input/{n}", s.handleChunk)
	mux.HandleFunc("POST /job/start", s.handleStart)
	mux.HandleFunc("GET /job/status", s.handleStatus)
	mux.HandleFunc("GET /out/manifest.json", s.handleManifest)
	mux.HandleFunc("GET /out/{path...}", s.handleOut)
	return mux
}

// Every response carries a body, errors included (the mux's own 404 and 405 do): a bodyless
// response breaks the next request on a pooled connection in workerd (workerd#7597). A test sweeps
// every route.
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
	st := s.status
	st.Ready = append([]string{}, s.status.Ready...)
	if s.status.Pages != nil {
		p := *s.status.Pages
		st.Pages = &p
	}
	return st
}

func (s *Server) set(stage string, pct int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.Stage = stage
	s.status.Pct = max(s.status.Pct, min(pct, 99))
}

func (s *Server) setPages(done, total int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.Pages = &PagesStatus{Done: done, Total: total}
}

func (s *Server) fail(code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.started = true
	s.status.State = stateFailed
	s.status.Error = &code
	s.status.Ready = []string{} // a failed job publishes nothing, page 1 included
	s.byPath = map[string]OutFile{}
	s.preview = nil
}

// publishPreview lists a video's 720p files ready and serves their manifest at /out/preview.json: the same shape as
// the finished job's, so the caller checks it the same way.
// The files are served from `root` while the preview is listed, so the full encode never rewrites a file in flight;
// the listing and the manifest appear together.
func (s *Server) publishPreview(root string, files []OutFile, m *Manifest) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.previewDir = root
	s.preview = m
	for _, f := range files {
		s.byPath[f.Path] = f
		s.status.Ready = append(s.status.Ready, f.Path)
	}
}

// publish makes validated files fetchable before the job is done.
func (s *Server) publish(files []OutFile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range files {
		s.byPath[f.Path] = f
		s.status.Ready = append(s.status.Ready, f.Path)
	}
}

func (s *Server) finish(m *Manifest) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.manifest = m
	s.preview = nil
	s.byPath = make(map[string]OutFile, len(m.Files))
	for _, f := range m.Files {
		s.byPath[f.Path] = f
	}
	s.status = Status{State: stateDone, Stage: "done", Pct: 100, Pages: s.status.Pages, Ready: []string{}}
}

func chunkPath(cfg Config, n int) string {
	return filepath.Join(cfg.WorkDir, "in", "chunk-"+strconv.Itoa(n))
}

func inputPath(cfg Config, ext string) (string, error) {
	return within(filepath.Join(cfg.WorkDir, "in"), "original."+ext)
}

var errNotLocal = errors.New("name is not one file in its directory")

// within joins name under dir, accepting only one plain file name: not empty, absolute or "..", and no
// separator, since "x/../chunk-0" stays local yet names a sibling. Every path built from a request value
// goes through it.
func within(dir, name string) (string, error) {
	if !filepath.IsLocal(name) || filepath.Base(name) != name {
		return "", fmt.Errorf("%w: %q", errNotLocal, name)
	}
	return filepath.Join(dir, name), nil
}

// handleChunk stores one input chunk. A chunk may be sent again until the job starts.
func (s *Server) handleChunk(w http.ResponseWriter, r *http.Request) {
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n < 0 || n >= maxChunkIndex {
		apiError(w, http.StatusBadRequest, "bad_chunk")
		return
	}
	s.mu.Lock()
	switch {
	case s.started || s.starting:
		s.mu.Unlock()
		apiError(w, http.StatusConflict, "job_already_started")
		return
	}
	if _, busy := s.uploading[n]; busy {
		s.mu.Unlock()
		apiError(w, http.StatusConflict, "chunk_in_progress")
		return
	}
	// Chunks in flight count at the room they were granted, so parallel uploads cannot pass MaxInput together.
	var others int64
	for i, size := range s.chunks {
		if i != n {
			others += size
		}
	}
	for _, granted := range s.uploading {
		others += granted
	}
	room := s.cfg.MaxInput - others
	granted := max(min(s.cfg.MaxChunk, room), 0)
	s.uploading[n] = granted
	s.mu.Unlock()

	size, err := s.storeChunk(w, r, n, granted)
	s.mu.Lock()
	delete(s.uploading, n)
	if err == nil {
		s.chunks[n] = size
	} else {
		delete(s.chunks, n)
	}
	s.mu.Unlock()
	if err != nil {
		log.Printf("chunk %d: %v", n, err)
		var tooBig *http.MaxBytesError
		switch {
		case errors.As(err, &tooBig) && room < s.cfg.MaxChunk:
			s.fail(errTooLarge)
			apiError(w, http.StatusRequestEntityTooLarge, errTooLarge)
		case errors.As(err, &tooBig):
			apiError(w, http.StatusRequestEntityTooLarge, "chunk_too_large")
		default:
			apiError(w, http.StatusBadRequest, errUpload)
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"n": int64(n), "size": size})
}

func (s *Server) storeChunk(w http.ResponseWriter, r *http.Request, n int, limit int64) (int64, error) {
	http.NewResponseController(w).SetReadDeadline(time.Now().Add(30 * time.Minute))
	if err := os.MkdirAll(filepath.Join(s.cfg.WorkDir, "in"), 0o700); err != nil {
		return 0, err
	}
	path := chunkPath(s.cfg, n)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	size, err := io.Copy(f, http.MaxBytesReader(w, r.Body, max(limit, 0)))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(path)
		return 0, err
	}
	return size, nil
}

// handleStart checks the chunks against the declared size and SHA-256, assembles the input, and
// starts the pipeline. A mismatch leaves the container unspent so the caller can resend.
func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	var req startRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxStartBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil || !reJobID.MatchString(req.JobID) || !reSHA256.MatchString(req.SHA256) || req.Size < 1 || req.Chunks < 1 {
		apiError(w, http.StatusBadRequest, "bad_start")
		return
	}
	ext := strings.ToLower(strings.TrimPrefix(req.Ext, "."))
	kind, known := kindByExt[ext]
	var input string
	err := errNotLocal
	if known {
		input, err = inputPath(s.cfg, ext)
	}
	switch {
	case err != nil:
		apiError(w, http.StatusUnsupportedMediaType, "unsupported_ext")
		return
	case req.Chunks > maxChunkIndex:
		apiError(w, http.StatusBadRequest, "bad_start")
		return
	case req.Size > s.cfg.MaxInput:
		apiError(w, http.StatusRequestEntityTooLarge, errTooLarge)
		return
	}
	s.mu.Lock()
	switch {
	case s.started || s.starting:
		s.mu.Unlock()
		apiError(w, http.StatusConflict, "job_already_started")
		return
	case len(s.uploading) > 0:
		s.mu.Unlock()
		apiError(w, http.StatusConflict, "chunk_in_progress")
		return
	}
	var sum int64
	complete := len(s.chunks) == req.Chunks
	for i := range req.Chunks {
		size, ok := s.chunks[i]
		complete = complete && ok
		sum += size
	}
	if !complete || sum != req.Size {
		s.mu.Unlock()
		apiError(w, http.StatusUnprocessableEntity, "chunks_mismatch")
		return
	}
	s.starting = true
	s.mu.Unlock()

	if err := s.assemble(input, req); err != nil {
		s.mu.Lock()
		s.starting = false
		s.mu.Unlock()
		if errors.Is(err, errDigest) {
			apiError(w, http.StatusUnprocessableEntity, "sha256_mismatch")
			return
		}
		log.Printf("job %s: assemble: %v", req.JobID, err)
		s.fail(errInternal)
		apiError(w, http.StatusInternalServerError, errInternal)
		return
	}
	s.mu.Lock()
	s.started = true
	s.starting = false
	s.status = Status{State: stateRunning, Stage: "inspect", Ready: []string{}}
	s.mu.Unlock()
	go s.process(jobInfo{id: req.JobID, ext: ext, kind: kind, sha256: req.SHA256, input: input})
	writeJSON(w, http.StatusAccepted, map[string]string{"state": stateRunning})
}

var errDigest = errors.New("digest mismatch")

// assemble verifies the chunks' SHA-256 in order, then joins them into dst, deleting each
// chunk as it goes so the disk holds the input about once.
func (s *Server) assemble(dst string, req startRequest) error {
	h := sha256.New()
	for i := range req.Chunks {
		f, err := os.Open(chunkPath(s.cfg, i))
		if err != nil {
			return err
		}
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil {
			return err
		}
	}
	if hex.EncodeToString(h.Sum(nil)) != req.SHA256 {
		return errDigest
	}
	if req.Chunks == 1 {
		return os.Rename(chunkPath(s.cfg, 0), dst)
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	for i := range req.Chunks {
		p := chunkPath(s.cfg, i)
		in, err := os.Open(p)
		if err != nil {
			out.Close()
			return err
		}
		_, err = io.Copy(out, in)
		in.Close()
		if err != nil {
			out.Close()
			return fmt.Errorf("append chunk %d: %w", i, err)
		}
		os.Remove(p)
	}
	return out.Close()
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

// handleOut serves one published file: a manifest entry or one listed in status.ready. Nothing is
// joined from the URL.
func (s *Server) handleOut(w http.ResponseWriter, r *http.Request) {
	if r.PathValue("path") == "preview.json" {
		s.mu.Lock()
		m := s.preview
		s.mu.Unlock()
		if m == nil {
			apiError(w, http.StatusConflict, "not_ready")
			return
		}
		writeJSON(w, http.StatusOK, m)
		return
	}
	s.mu.Lock()
	entry, ok := s.byPath[r.PathValue("path")]
	done := s.manifest != nil
	base := filepath.Join(s.cfg.WorkDir, "out")
	if s.preview != nil {
		base = s.previewDir
	}
	s.mu.Unlock()
	if !ok {
		if done {
			apiError(w, http.StatusNotFound, "not_found")
		} else {
			apiError(w, http.StatusConflict, "not_ready")
		}
		return
	}
	f, err := os.Open(filepath.Join(base, filepath.FromSlash(entry.Path)))
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
