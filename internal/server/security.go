package server

import (
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
)

const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; " +
	"img-src 'self' https: http: data:; connect-src 'self'; object-src 'none'; " +
	"base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

// CheckLoopback ensures addr is host:port with one of the hosts that the Host
// header check accepts, so the server never listens where it would reject requests.
func CheckLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid address %q: %v", addr, err)
	}
	if !isLoopbackName(host) {
		return fmt.Errorf("address %q is not allowed; only localhost, 127.0.0.1 and ::1 are", addr)
	}
	return nil
}

func isLoopbackName(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// isAllowedHost reports whether the Host header is localhost:<port>,
// 127.0.0.1:<port> or [::1]:<port> (DNS rebinding protection).
func isAllowedHost(host string, port int) bool {
	h, p, err := net.SplitHostPort(host)
	if err != nil || p != strconv.Itoa(port) {
		return false
	}
	return isLoopbackName(h)
}

func isSafeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// checkWriteRequest validates CSRF protections for state-changing requests.
// It returns an empty string if the request is allowed, else a reason.
func checkWriteRequest(r *http.Request) string {
	if isSafeMethod(r.Method) {
		return ""
	}
	if r.Header.Get("X-Requested-With") != "startpage" {
		return "X-Requested-With header missing or invalid"
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		if !strings.EqualFold(origin, "http://"+r.Host) {
			return "origin not allowed"
		}
	}
	return ""
}

func setSecurityHeaders(h http.Header) {
	h.Set("Content-Security-Policy", contentSecurityPolicy)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
}

// securityMiddleware applies security headers, the Host check and the
// write-request (CSRF) checks to every request.
func securityMiddleware(port int, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w.Header())
		if !isAllowedHost(r.Host, port) {
			writeError(w, http.StatusForbidden, "host not allowed")
			return
		}
		if reason := checkWriteRequest(r); reason != "" {
			writeError(w, http.StatusForbidden, reason)
			return
		}
		next.ServeHTTP(w, r)
	})
}
