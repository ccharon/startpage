package server

import (
	"net/http/httptest"
	"testing"
)

func TestIsAllowedHost(t *testing.T) {
	cases := []struct {
		host string
		ok   bool
	}{
		{"localhost:8765", true},
		{"LOCALHOST:8765", true},
		{"127.0.0.1:8765", true},
		{"[::1]:8765", true},
		{"localhost:8766", false},
		{"localhost", false},
		{"127.0.0.1", false},
		{"evil.com:8765", false},
		{"localhost.evil.com:8765", false},
		{"127.0.0.2:8765", false},
		{"", false},
	}
	for _, c := range cases {
		if got := isAllowedHost(c.host, 8765); got != c.ok {
			t.Errorf("isAllowedHost(%q) = %v, want %v", c.host, got, c.ok)
		}
	}
}

func TestCheckWriteRequest(t *testing.T) {
	cases := []struct {
		name, method, xrw, origin string
		ok                        bool
	}{
		{"get no header", "GET", "", "", true},
		{"head", "HEAD", "", "http://evil.com", true},
		{"put ok", "PUT", "startpage", "", true},
		{"put ok origin", "PUT", "startpage", "http://localhost:8765", true},
		{"put no xrw", "PUT", "", "http://localhost:8765", false},
		{"put wrong xrw", "PUT", "XMLHttpRequest", "", false},
		{"put bad origin", "PUT", "startpage", "http://evil.com", false},
		{"put https origin", "PUT", "startpage", "https://localhost:8765", false},
		{"put other port", "PUT", "startpage", "http://localhost:9999", false},
		{"post no xrw", "POST", "", "", false},
		{"delete null origin", "DELETE", "startpage", "null", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, "http://localhost:8765/api/bookmarks", nil)
		if c.xrw != "" {
			r.Header.Set("X-Requested-With", c.xrw)
		}
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if got := checkWriteRequest(r) == ""; got != c.ok {
			t.Errorf("%s: allowed=%v, want %v", c.name, got, c.ok)
		}
	}
}

func TestCheckLoopback(t *testing.T) {
	for _, a := range []string{"127.0.0.1:8765", "localhost:8765", "LOCALHOST:1", "[::1]:8765"} {
		if err := CheckLoopback(a); err != nil {
			t.Errorf("%s: unexpected error %v", a, err)
		}
	}
	for _, a := range []string{"0.0.0.0:8765", ":8765", "192.168.1.1:8765", "example.com:80", "127.0.0.1", "127.0.0.5:8765"} {
		if err := CheckLoopback(a); err == nil {
			t.Errorf("%s: expected error", a)
		}
	}
}
