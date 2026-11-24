package server

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"strings"

	"github.com/ccharon/startpage/internal/store"
)

const maxBodyBytes = 5 << 20

func init() {
	// Windows may map extensions to wrong types via the registry.
	for ext, typ := range map[string]string{
		".html": "text/html; charset=utf-8",
		".js":   "text/javascript; charset=utf-8",
		".mjs":  "text/javascript; charset=utf-8",
		".css":  "text/css; charset=utf-8",
		".json": "application/json",
		".svg":  "image/svg+xml",
		".ico":  "image/x-icon",
		".png":  "image/png",
	} {
		_ = mime.AddExtensionType(ext, typ)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeData(w http.ResponseWriter, data []byte, etag string) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("ETag", etag)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// loadErrorMessage passes the reason for an invalid data file to the page,
// so the user learns which file to repair or restore.
func loadErrorMessage(err error) string {
	var ife *store.InvalidFileError
	if errors.As(err, &ife) {
		return ife.Error()
	}
	return "could not read the data"
}

// openSearchXML describes the page as a browser search engine. The template
// needs an absolute URL; host has passed the Host header check.
func openSearchXML(host string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Bookmarks</ShortName>
  <Description>Search the bookmarks of the local start page</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="text/html" method="get" template="http://`)
	_ = xml.EscapeText(&b, []byte(host))
	b.WriteString(`/?q={searchTerms}"/>
</OpenSearchDescription>
`)
	return b.String()
}

// New builds the complete HTTP handler: the JSON API backed by st, the static
// frontend files from static, and the security checks for the given port.
func New(st *store.Store, port int, static fs.FS) (http.Handler, error) {
	if static == nil {
		return nil, errors.New("server: static file system is nil")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/bookmarks", func(w http.ResponseWriter, r *http.Request) {
		data, etag, err := st.Load()
		if err != nil {
			log.Printf("load: %v", err)
			writeError(w, http.StatusInternalServerError, loadErrorMessage(err))
			return
		}
		writeData(w, data, etag)
	})
	mux.HandleFunc("PUT /api/bookmarks", func(w http.ResponseWriter, r *http.Request) {
		ifMatch := r.Header.Get("If-Match")
		if ifMatch == "" {
			writeError(w, http.StatusPreconditionRequired, "If-Match header missing")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				writeError(w, http.StatusRequestEntityTooLarge, "request too large (max. 5 MB)")
				return
			}
			writeError(w, http.StatusBadRequest, "could not read the request")
			return
		}
		data, etag, err := st.Save(ifMatch, body)
		var ve *store.ValidationError
		var ife *store.InvalidFileError
		switch {
		case err == nil:
			writeData(w, data, etag)
		case errors.As(err, &ve):
			writeError(w, http.StatusBadRequest, ve.Msg)
		case errors.As(err, &ife):
			log.Printf("save: %v", err)
			writeError(w, http.StatusInternalServerError, ife.Error())
		case errors.Is(err, store.ErrPreconditionFailed):
			writeError(w, http.StatusPreconditionFailed, err.Error())
		default:
			log.Printf("save: %v", err)
			writeError(w, http.StatusInternalServerError, "could not save the data")
		}
	})
	mux.HandleFunc("GET /opensearch.xml", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/opensearchdescription+xml; charset=utf-8")
		_, _ = io.WriteString(w, openSearchXML(r.Host))
	})
	mux.HandleFunc("GET /api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})
	mux.Handle("GET /", http.FileServerFS(static))
	return securityMiddleware(port, mux), nil
}
