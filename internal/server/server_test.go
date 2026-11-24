package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/ccharon/startpage/internal/store"
)

const testPort = 8765

// etagOf mirrors the store's ETag format (quoted SHA-256 of the body).
func etagOf(b []byte) string {
	sum := sha256.Sum256(b)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

func validDoc(t *testing.T, title string) []byte {
	t.Helper()
	d := store.Data{Version: 1, Categories: []store.Category{{
		ID: "c1", Name: "Work", Bookmarks: []store.Bookmark{
			{ID: "b1", Title: title, URL: "https://example.com/x", Tags: []string{"a"}},
		},
	}}}
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func newTestHandler(t *testing.T) http.Handler {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "bookmarks.json"), 3)
	if err != nil {
		t.Fatal(err)
	}
	static := fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html><title>x</title>")},
		"app.js":     {Data: []byte("console.log(1)")},
		"style.css":  {Data: []byte("body{}")},
	}
	h, err := New(s, testPort, static)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func do(h http.Handler, method, path string, body []byte, hdr map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://localhost:8765"+path, bytes.NewReader(body))
	for k, v := range hdr {
		if k == "Host" {
			r.Host = v
			continue
		}
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func assertJSONError(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status = %d, want %d, body %s", w.Code, status, w.Body)
	}
	var e map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil || e["error"] == "" {
		t.Fatalf("expected JSON error body, got %q", w.Body)
	}
}

func TestHealth(t *testing.T) {
	h := newTestHandler(t)
	w := do(h, "GET", "/api/health", nil, nil)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"status":"ok"}` {
		t.Fatalf("health: %d %s", w.Code, w.Body)
	}
	for k, v := range map[string]string{
		"Content-Security-Policy": contentSecurityPolicy,
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "no-referrer",
	} {
		if got := w.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
}

func TestBookmarksFlow(t *testing.T) {
	h := newTestHandler(t)
	w := do(h, "GET", "/api/bookmarks", nil, nil)
	if w.Code != 200 {
		t.Fatalf("GET: %d", w.Code)
	}
	etag := w.Header().Get("ETag")
	if etag != etagOf(w.Body.Bytes()) {
		t.Fatalf("ETag %q does not match body hash", etag)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("missing Cache-Control: no-store")
	}

	body := validDoc(t, "Jira")
	write := map[string]string{"X-Requested-With": "startpage", "Origin": "http://localhost:8765"}

	assertJSONError(t, do(h, "PUT", "/api/bookmarks", body, write), http.StatusPreconditionRequired)

	bad := map[string]string{"X-Requested-With": "startpage", "If-Match": `"deadbeef"`}
	assertJSONError(t, do(h, "PUT", "/api/bookmarks", body, bad), http.StatusPreconditionFailed)

	write["If-Match"] = etag
	w = do(h, "PUT", "/api/bookmarks", body, write)
	if w.Code != 200 {
		t.Fatalf("PUT: %d %s", w.Code, w.Body)
	}
	newETag := w.Header().Get("ETag")
	if newETag == "" || newETag == etag || newETag != etagOf(w.Body.Bytes()) {
		t.Fatalf("bad new ETag %q", newETag)
	}
	if !strings.Contains(w.Body.String(), "Jira") {
		t.Fatal("PUT response does not contain stored data")
	}

	// the ETag from before the PUT is stale
	assertJSONError(t, do(h, "PUT", "/api/bookmarks", body, write), http.StatusPreconditionFailed)

	w = do(h, "GET", "/api/bookmarks", nil, nil)
	if w.Header().Get("ETag") != newETag {
		t.Fatal("GET after PUT returns different ETag")
	}

	write["If-Match"] = newETag
	assertJSONError(t, do(h, "PUT", "/api/bookmarks",
		[]byte(`{"version":1,"categories":[{"id":"c","name":"n","order":0,"bookmarks":[{"id":"b","title":"t","url":"javascript:alert(1)","order":0}]}]}`),
		write), http.StatusBadRequest)
}

func TestPutTooLarge(t *testing.T) {
	h := newTestHandler(t)
	etag := do(h, "GET", "/api/bookmarks", nil, nil).Header().Get("ETag")
	big := bytes.Repeat([]byte(" "), maxBodyBytes+1)
	w := do(h, "PUT", "/api/bookmarks", big, map[string]string{"X-Requested-With": "startpage", "If-Match": etag})
	assertJSONError(t, w, http.StatusRequestEntityTooLarge)
}

func TestWriteProtection(t *testing.T) {
	h := newTestHandler(t)
	etag := do(h, "GET", "/api/bookmarks", nil, nil).Header().Get("ETag")
	body := validDoc(t, "x")
	assertJSONError(t, do(h, "PUT", "/api/bookmarks", body, map[string]string{"If-Match": etag}), http.StatusForbidden)
	assertJSONError(t, do(h, "PUT", "/api/bookmarks", body, map[string]string{
		"If-Match": etag, "X-Requested-With": "startpage", "Origin": "http://evil.com",
	}), http.StatusForbidden)
}

func TestHostCheckMiddleware(t *testing.T) {
	h := newTestHandler(t)
	w := do(h, "GET", "/api/health", nil, map[string]string{"Host": "evil.com:8765"})
	assertJSONError(t, w, http.StatusForbidden)
	if w.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("security headers missing on 403")
	}
	if w := do(h, "GET", "/api/health", nil, map[string]string{"Host": "127.0.0.1:8765"}); w.Code != 200 {
		t.Fatalf("127.0.0.1 rejected: %d", w.Code)
	}
}

func TestStatic(t *testing.T) {
	h := newTestHandler(t)
	for path, ct := range map[string]string{
		"/":          "text/html",
		"/app.js":    "text/javascript",
		"/style.css": "text/css",
	} {
		w := do(h, "GET", path, nil, nil)
		if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), ct) {
			t.Errorf("%s: %d %q", path, w.Code, w.Header().Get("Content-Type"))
		}
	}
	assertJSONError(t, do(h, "GET", "/api/unknown", nil, nil), http.StatusNotFound)
}

func TestInvalidDataFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bookmarks.json")
	if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	h, err := New(st, testPort, fstest.MapFS{})
	if err != nil {
		t.Fatal(err)
	}
	w := do(h, "GET", "/api/bookmarks", nil, nil)
	assertJSONError(t, w, http.StatusInternalServerError)
	if !strings.Contains(w.Body.String(), "is invalid") {
		t.Fatalf("error should name the invalid file: %s", w.Body)
	}
}

func TestOpenSearch(t *testing.T) {
	h := newTestHandler(t)
	w := do(h, "GET", "/opensearch.xml", nil, nil)
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/opensearchdescription+xml") {
		t.Fatalf("%d %q", w.Code, w.Header().Get("Content-Type"))
	}
	if !strings.Contains(w.Body.String(), `template="http://localhost:8765/?q={searchTerms}"`) {
		t.Fatalf("unexpected template: %s", w.Body)
	}
}
