package main

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestDefaultDataPathXDG(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows keeps the data next to the executable")
	}
	t.Setenv("XDG_DATA_HOME", "/xdg/data")
	if got, want := defaultDataPath(), "/xdg/data/startpage/bookmarks.json"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	t.Setenv("XDG_DATA_HOME", "relative") // the spec says to ignore relative paths
	t.Setenv("HOME", "/home/u")
	if got, want := defaultDataPath(), filepath.FromSlash("/home/u/.local/share/startpage/bookmarks.json"); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
