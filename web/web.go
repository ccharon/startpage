// Package web embeds the frontend (static HTML, JavaScript and CSS without a
// build step) into the binary.
package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var files embed.FS

// Static returns the frontend files with index.html at the root.
func Static() fs.FS {
	sub, err := fs.Sub(files, "static")
	if err != nil {
		panic(err) // the path is a constant; this cannot fail
	}
	return sub
}
