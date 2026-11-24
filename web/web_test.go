package web

import (
	"io/fs"
	"testing"
)

func TestStaticFiles(t *testing.T) {
	for _, name := range []string{"index.html", "app.js", "style.css"} {
		if _, err := fs.Stat(Static(), name); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}
