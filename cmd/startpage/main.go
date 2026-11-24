// Command startpage serves a local bookmark start page on a loopback address.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/ccharon/startpage/internal/server"
	"github.com/ccharon/startpage/internal/store"
	"github.com/ccharon/startpage/web"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}

// defaultDataPath follows the XDG base directory spec on Unix
// ($XDG_DATA_HOME/startpage/bookmarks.json). On Windows the data stays next
// to the executable, so the program can be used portably.
func defaultDataPath() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(exeDir(), "bookmarks.json")
	}
	dir := os.Getenv("XDG_DATA_HOME")
	if dir == "" || !filepath.IsAbs(dir) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "bookmarks.json"
		}
		dir = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(dir, "startpage", "bookmarks.json")
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8765", "listen address (loopback only)")
	dataPath := flag.String("data", defaultDataPath(), "path to the bookmark JSON file")
	backups := flag.Int("backups", 10, "number of rotating backups (0 = none)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("startpage", version)
		return
	}

	setupLogging()

	if err := run(*addr, *dataPath, *backups); err != nil {
		log.Printf("error: %v", err)
		os.Exit(1)
	}
}

// setupLogging writes to stderr (journald under systemd). On Windows the
// console may be detached (autostart, double-click), so the log also goes to
// startpage.log next to the executable.
func setupLogging() {
	log.SetFlags(log.LstdFlags)
	if runtime.GOOS != "windows" {
		return
	}
	detached := detachOwnConsole()
	f, err := os.OpenFile(filepath.Join(exeDir(), "startpage.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	if detached {
		log.SetOutput(f)
	} else {
		log.SetOutput(io.MultiWriter(f, os.Stderr))
	}
}

func run(addr, dataPath string, backups int) error {
	if err := server.CheckLoopback(addr); err != nil {
		return err
	}
	if backups < 0 {
		return fmt.Errorf("-backups must not be negative")
	}
	st, err := store.Open(dataPath, backups)
	if err != nil {
		return fmt.Errorf("data file %q: %w", dataPath, err)
	}
	// The server still starts, so the page can show the problem.
	if _, _, err := st.Load(); err != nil {
		log.Printf("warning: %v", err)
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		var errno syscall.Errno
		if errors.Is(err, syscall.EADDRINUSE) || (errors.As(err, &errno) && errno == 10048) { // 10048 = WSAEADDRINUSE
			return fmt.Errorf("port in use (%s), is another instance running? %v", addr, err)
		}
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	handler, err := server.New(st, port, web.Static())
	if err != nil {
		ln.Close()
		return err
	}
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	log.Printf("startpage %s running on http://localhost:%d (data: %s, backups: %d)", version, port, st.Path(), backups)

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	log.Printf("shutting down ...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	log.Printf("server stopped")
	return nil
}
