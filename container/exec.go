package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"syscall"
	"time"
)

// cmdSpec is one external tool run. The environment is built from scratch: nothing is inherited.
type cmdSpec struct {
	name   string
	args   []string
	env    []string
	onLine func(string) // optional: called for each stdout line (ffmpeg -progress)
}

// runner runs one tool to completion under ctx and returns its stdout.
// Tests replace it; production uses runCmd.
type runner func(ctx context.Context, spec cmdSpec) ([]byte, error)

const (
	maxCapturedOutput = 4 << 20
	killGrace         = 2 * time.Second
)

// capBuffer keeps the first max bytes and drops the rest, so a chatty tool cannot grow memory.
type capBuffer struct {
	buf bytes.Buffer
	max int
}

func (c *capBuffer) Write(p []byte) (int, error) {
	if room := c.max - c.buf.Len(); room > 0 {
		c.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// lineWriter splits writes into lines and forwards each, while also capturing the bytes.
type lineWriter struct {
	capture *capBuffer
	onLine  func(string)
	pending []byte
}

func (l *lineWriter) Write(p []byte) (int, error) {
	l.capture.Write(p)
	l.pending = append(l.pending, p...)
	for {
		i := bytes.IndexByte(l.pending, '\n')
		if i < 0 {
			break
		}
		l.onLine(string(l.pending[:i]))
		l.pending = l.pending[i+1:]
	}
	if len(l.pending) > 64<<10 {
		l.pending = nil
	}
	return len(p), nil
}

// runCmd runs the tool in its own process group and kills the whole group when the tool ends or
// ctx does, so soffice's child (soffice.bin) never outlives its stage.
func runCmd(ctx context.Context, spec cmdSpec) ([]byte, error) {
	cmd := exec.CommandContext(ctx, spec.name, spec.args...)
	cmd.Env = spec.env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = killGrace
	out := &capBuffer{max: maxCapturedOutput}
	errOut := &capBuffer{max: 8 << 10}
	var stdout io.Writer = out
	if spec.onLine != nil {
		stdout = &lineWriter{capture: out, onLine: spec.onLine}
	}
	cmd.Stdout = stdout
	cmd.Stderr = errOut
	err := cmd.Run()
	if cmd.Process != nil {
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) // a child the leader left behind dies with its group
	}
	if errors.Is(err, exec.ErrWaitDelay) && cmd.ProcessState.Success() {
		err = nil // the leader succeeded; a leftover child only held the pipes open
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return out.buf.Bytes(), ctxErr
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return out.buf.Bytes(), fmt.Errorf("%s: %w: %s", spec.name, err, bytes.TrimSpace(errOut.buf.Bytes()))
		}
		return out.buf.Bytes(), fmt.Errorf("%s: %w", spec.name, err)
	}
	return out.buf.Bytes(), nil
}
