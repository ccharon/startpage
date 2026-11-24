package store

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"unicode/utf8"
)

const (
	dataVersion    = 1
	maxNameLen     = 500
	maxTitleLen    = 500
	maxURLLen      = 4096
	maxTagLen      = 100
	maxTagsPerItem = 100
	maxIDLen       = 200
)

// Data is the complete bookmark document as stored in the data file.
type Data struct {
	Version    int        `json:"version"`
	Categories []Category `json:"categories"`
}

// Category is a named group of bookmarks, shown as one window on the page.
type Category struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Order int    `json:"order"`
	// Inline places the category in the same row as the previous one.
	Inline    bool       `json:"inline,omitempty"`
	Bookmarks []Bookmark `json:"bookmarks"`
}

// Bookmark is a single link with optional tags.
type Bookmark struct {
	ID    string   `json:"id"`
	Title string   `json:"title"`
	URL   string   `json:"url"`
	Tags  []string `json:"tags"`
	Order int      `json:"order"`
	// Visits and LastVisit (Unix seconds) rank often used bookmarks higher in the search.
	Visits    int   `json:"visits,omitempty"`
	LastVisit int64 `json:"lastVisit,omitempty"`
}

// ValidationError signals invalid client data (HTTP 400).
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, a ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, a...)}
}

// parseAndValidate decodes raw JSON strictly, validates it and returns the
// normalized, indented JSON representation.
func parseAndValidate(raw []byte) ([]byte, *Data, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var d Data
	if err := dec.Decode(&d); err != nil {
		return nil, nil, invalid("invalid JSON: %v", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, nil, invalid("invalid JSON: extra data after the document")
	}
	if err := validateData(&d); err != nil {
		return nil, nil, err
	}
	out, err := marshalData(&d)
	if err != nil {
		return nil, nil, err
	}
	return out, &d, nil
}

func marshalData(d *Data) ([]byte, error) {
	out, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

// validateData checks the document and normalizes nil slices to empty ones.
func validateData(d *Data) error {
	if d.Version != dataVersion {
		return invalid("version must be %d", dataVersion)
	}
	if d.Categories == nil {
		d.Categories = []Category{}
	}
	catIDs := map[string]bool{}
	bmIDs := map[string]bool{}
	for ci := range d.Categories {
		c := &d.Categories[ci]
		if err := checkID(c.ID, catIDs, "category"); err != nil {
			return err
		}
		name := strings.TrimSpace(c.Name)
		if name == "" {
			return invalid("category %q: name must not be empty", c.ID)
		}
		if utf8.RuneCountInString(c.Name) > maxNameLen {
			return invalid("category %q: name too long (max. %d characters)", c.ID, maxNameLen)
		}
		if c.Bookmarks == nil {
			c.Bookmarks = []Bookmark{}
		}
		for bi := range c.Bookmarks {
			b := &c.Bookmarks[bi]
			if err := checkID(b.ID, bmIDs, "bookmark"); err != nil {
				return err
			}
			if strings.TrimSpace(b.Title) == "" {
				return invalid("bookmark %q: title must not be empty", b.ID)
			}
			if utf8.RuneCountInString(b.Title) > maxTitleLen {
				return invalid("bookmark %q: title too long (max. %d characters)", b.ID, maxTitleLen)
			}
			if err := validateURL(b.URL); err != nil {
				return invalid("bookmark %q: %v", b.ID, err)
			}
			if b.Tags == nil {
				b.Tags = []string{}
			}
			if len(b.Tags) > maxTagsPerItem {
				return invalid("bookmark %q: too many tags (max. %d)", b.ID, maxTagsPerItem)
			}
			for _, t := range b.Tags {
				if utf8.RuneCountInString(t) > maxTagLen {
					return invalid("bookmark %q: tag too long (max. %d characters)", b.ID, maxTagLen)
				}
			}
			if b.Visits < 0 || b.LastVisit < 0 {
				return invalid("bookmark %q: usage counters must not be negative", b.ID)
			}
		}
	}
	return nil
}

func checkID(id string, seen map[string]bool, kind string) error {
	if strings.TrimSpace(id) == "" {
		return invalid("%s: id must not be empty", kind)
	}
	if len(id) > maxIDLen {
		return invalid("%s: id too long", kind)
	}
	if seen[id] {
		return invalid("%s: duplicate id %q", kind, id)
	}
	seen[id] = true
	return nil
}

func validateURL(raw string) error {
	if raw == "" {
		return errors.New("URL must not be empty")
	}
	if len(raw) > maxURLLen {
		return fmt.Errorf("URL too long (max. %d characters)", maxURLLen)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid URL: %v", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return errors.New("only http and https URLs are allowed")
	}
	if u.Host == "" || u.Hostname() == "" {
		return errors.New("URL without host")
	}
	return nil
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func defaultData() *Data {
	return &Data{
		Version: dataVersion,
		Categories: []Category{{
			ID:    newUUID(),
			Name:  "General",
			Order: 0,
			Bookmarks: []Bookmark{{
				ID:    newUUID(),
				Title: "Go",
				URL:   "https://go.dev",
				Tags:  []string{"example"},
				Order: 0,
			}},
		}},
	}
}
