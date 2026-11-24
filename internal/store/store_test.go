package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func validDoc(t *testing.T, title string) []byte {
	t.Helper()
	d := Data{Version: 1, Categories: []Category{{
		ID: "c1", Name: "Work", Bookmarks: []Bookmark{
			{ID: "b1", Title: title, URL: "https://example.com/x", Tags: []string{"a"}},
		},
	}}}
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestMissingFileInit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "bookmarks.json")
	s, err := Open(path, 3)
	if err != nil {
		t.Fatal(err)
	}
	b, etag, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if etag != computeETag(b) {
		t.Fatalf("etag mismatch")
	}
	disk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(disk) != string(b) {
		t.Fatal("file content differs from Load")
	}
	if _, d, err := parseAndValidate(b); err != nil {
		t.Fatalf("default data invalid: %v", err)
	} else if len(d.Categories) != 1 || d.Categories[0].Name != "General" || len(d.Categories[0].Bookmarks) != 1 {
		t.Fatalf("unexpected default data: %+v", d)
	}
}

func TestAtomicWriteNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bookmarks.json")
	s, err := Open(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, etag, _ := s.Load()
	out, newETag, err := s.Save(etag, validDoc(t, "Jira"))
	if err != nil {
		t.Fatal(err)
	}
	if newETag == etag || newETag != computeETag(out) {
		t.Fatal("bad new etag")
	}
	disk, _ := os.ReadFile(path)
	if string(disk) != string(out) {
		t.Fatal("disk content mismatch")
	}
	if !strings.Contains(string(disk), "\n  \"categories\"") {
		t.Fatalf("expected indented JSON, got %s", disk)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "bookmarks.json" {
			t.Fatalf("unexpected file left: %s", e.Name())
		}
	}
}

func TestETagPreconditionFailed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bookmarks.json")
	s, _ := Open(path, 2)
	_, etag, _ := s.Load()
	_, etag2, err := s.Save(etag, validDoc(t, "one"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Save(etag, validDoc(t, "two")); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("expected precondition failed, got %v", err)
	}
	// external modification changes the etag
	if err := os.WriteFile(path, validDoc(t, "external"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Save(etag2, validDoc(t, "three")); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("expected precondition failed after external edit, got %v", err)
	}
	b, cur, _ := s.Load()
	if !strings.Contains(string(b), "external") {
		t.Fatal("external edit not picked up")
	}
	if _, _, err := s.Save(cur, validDoc(t, "four")); err != nil {
		t.Fatal(err)
	}
}

func TestBackupRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bookmarks.json")
	s, _ := Open(path, 3)
	s.backupInterval = 0
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	calls := 0
	s.now = func() time.Time {
		calls++
		// two saves per second to exercise collision suffixes
		return base.Add(time.Duration(calls/2) * time.Second)
	}
	_, etag, _ := s.Load()
	var err error
	for i := 0; i < 7; i++ {
		_, etag, err = s.Save(etag, validDoc(t, fmt.Sprintf("t%d", i)))
		if err != nil {
			t.Fatal(err)
		}
	}
	list, err := s.listBackups()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3 backups, got %d: %+v", len(list), list)
	}
	// newest backup must contain the content before the last save (t5)
	b, _ := os.ReadFile(filepath.Join(s.backupDir, list[0].name))
	if !strings.Contains(string(b), `"t5"`) {
		t.Fatalf("newest backup has wrong content: %s (%s)", b, list[0].name)
	}
	entries, _ := os.ReadDir(s.backupDir)
	if len(entries) != 3 {
		t.Fatalf("expected 3 files in backup dir, got %d", len(entries))
	}
}

func TestBackupCollisionSuffix(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bookmarks.json")
	s, _ := Open(path, 10)
	s.backupInterval = 0
	fixed := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	s.now = func() time.Time { return fixed }
	_, etag, _ := s.Load()
	for i := 0; i < 3; i++ {
		var err error
		if _, etag, err = s.Save(etag, validDoc(t, fmt.Sprintf("t%d", i))); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range []string{"bookmarks-20260102-030405.json", "bookmarks-20260102-030405-1.json", "bookmarks-20260102-030405-2.json"} {
		if _, err := os.Stat(filepath.Join(s.backupDir, n)); err != nil {
			t.Fatalf("missing backup %s", n)
		}
	}
}

func TestNoBackupsWhenZero(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bookmarks.json")
	s, _ := Open(path, 0)
	_, etag, _ := s.Load()
	if _, _, err := s.Save(etag, validDoc(t, "x")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.backupDir); !os.IsNotExist(err) {
		t.Fatal("backup dir should not exist")
	}
}

func TestValidation(t *testing.T) {
	cases := map[string]string{
		"javascript url": `{"version":1,"categories":[{"id":"c","name":"n","order":0,"bookmarks":[{"id":"b","title":"t","url":"javascript:alert(1)","tags":[],"order":0}]}]}`,
		"data url":       `{"version":1,"categories":[{"id":"c","name":"n","order":0,"bookmarks":[{"id":"b","title":"t","url":"data:text/html,x","tags":[],"order":0}]}]}`,
		"no host":        `{"version":1,"categories":[{"id":"c","name":"n","order":0,"bookmarks":[{"id":"b","title":"t","url":"http:///x","tags":[],"order":0}]}]}`,
		"dup cat id":     `{"version":1,"categories":[{"id":"c","name":"n","order":0,"bookmarks":[]},{"id":"c","name":"m","order":1,"bookmarks":[]}]}`,
		"dup bm id":      `{"version":1,"categories":[{"id":"c","name":"n","order":0,"bookmarks":[{"id":"b","title":"t","url":"https://a.b","order":0}]},{"id":"d","name":"m","order":1,"bookmarks":[{"id":"b","title":"t","url":"https://a.b","order":0}]}]}`,
		"bad version":    `{"version":2,"categories":[]}`,
		"empty name":     `{"version":1,"categories":[{"id":"c","name":"  ","order":0,"bookmarks":[]}]}`,
		"empty title":    `{"version":1,"categories":[{"id":"c","name":"n","order":0,"bookmarks":[{"id":"b","title":"","url":"https://a.b","order":0}]}]}`,
		"empty id":       `{"version":1,"categories":[{"id":"","name":"n","order":0,"bookmarks":[]}]}`,
		"unknown field":  `{"version":1,"categories":[],"extra":true}`,
		"trailing data":  `{"version":1,"categories":[]} {}`,
		"not json":       `nope`,
		"long tag":       `{"version":1,"categories":[{"id":"c","name":"n","order":0,"bookmarks":[{"id":"b","title":"t","url":"https://a.b","tags":["` + strings.Repeat("x", 101) + `"],"order":0}]}]}`,
	}
	for name, doc := range cases {
		t.Run(name, func(t *testing.T) {
			_, _, err := parseAndValidate([]byte(doc))
			var ve *ValidationError
			if !errors.As(err, &ve) {
				t.Fatalf("expected validation error, got %v", err)
			}
		})
	}
}

func TestValidationNormalizes(t *testing.T) {
	out, d, err := parseAndValidate([]byte(`{"version":1,"categories":[{"id":"c","name":"n","order":0,"bookmarks":[{"id":"b","title":"t","url":"HTTPS://a.b/","order":0}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if d.Categories[0].Bookmarks[0].Tags == nil || !strings.Contains(string(out), `"tags": []`) {
		t.Fatalf("tags not normalized: %s", out)
	}
	if _, _, err := parseAndValidate([]byte(`{"version":1,"categories":null}`)); err != nil {
		t.Fatal(err)
	}
}

func TestValidationInline(t *testing.T) {
	out, d, err := parseAndValidate([]byte(`{"version":1,"categories":[{"id":"a","name":"a","order":0,"bookmarks":[]},{"id":"b","name":"b","order":1,"inline":true,"bookmarks":[]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if d.Categories[0].Inline || !d.Categories[1].Inline {
		t.Fatalf("inline not parsed: %+v", d.Categories)
	}
	if strings.Count(string(out), `"inline"`) != 1 {
		t.Fatalf("inline=false should be omitted: %s", out)
	}
}

func TestNewUUID(t *testing.T) {
	u := newUUID()
	if len(u) != 36 || u[14] != '4' {
		t.Fatalf("bad uuid %s", u)
	}
	if newUUID() == u {
		t.Fatal("uuid not unique")
	}
}

func TestBackupInterval(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bookmarks.json")
	s, _ := Open(path, 10)
	now := time.Date(2026, 1, 2, 3, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	_, etag, _ := s.Load()
	save := func(title string) {
		t.Helper()
		var err error
		if _, etag, err = s.Save(etag, validDoc(t, title)); err != nil {
			t.Fatal(err)
		}
	}
	save("a")
	now = now.Add(59 * time.Minute)
	save("b")
	if list, _ := s.listBackups(); len(list) != 1 {
		t.Fatalf("expected 1 backup within the interval, got %d", len(list))
	}
	now = now.Add(2 * time.Minute)
	save("c")
	list, _ := s.listBackups()
	if len(list) != 2 {
		t.Fatalf("expected 2 backups after the interval, got %d", len(list))
	}
	b, _ := os.ReadFile(filepath.Join(s.backupDir, list[0].name))
	if !strings.Contains(string(b), `"b"`) {
		t.Fatalf("newest backup should hold the state before the save: %s", b)
	}
}

func TestFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permissions only")
	}
	dir := filepath.Join(t.TempDir(), "data")
	s, err := Open(filepath.Join(dir, "bookmarks.json"), 3)
	if err != nil {
		t.Fatal(err)
	}
	_, etag, _ := s.Load()
	if _, _, err := s.Save(etag, validDoc(t, "x")); err != nil {
		t.Fatal(err)
	}
	list, _ := s.listBackups()
	for path, want := range map[string]os.FileMode{
		dir:                                      0o700,
		s.path:                                   0o600,
		s.backupDir:                              0o700,
		filepath.Join(s.backupDir, list[0].name): 0o600,
	} {
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := fi.Mode().Perm(); got != want {
			t.Errorf("%s: mode %o, want %o", path, got, want)
		}
	}
}

func TestInvalidFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bookmarks.json")
	if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path, 3)
	if err != nil {
		t.Fatalf("Open must tolerate an invalid file: %v", err)
	}
	var ife *InvalidFileError
	if _, _, err := s.Load(); !errors.As(err, &ife) {
		t.Fatalf("Load: expected InvalidFileError, got %v", err)
	}
	if _, _, err := s.Save("*", validDoc(t, "x")); !errors.As(err, &ife) {
		t.Fatalf("Save: expected InvalidFileError, got %v", err)
	}
	if b, _ := os.ReadFile(path); string(b) != "{broken" {
		t.Fatal("invalid file must stay untouched")
	}
}

func TestValidationUsage(t *testing.T) {
	ok := `{"version":1,"categories":[{"id":"c","name":"n","order":0,"bookmarks":[{"id":"b","title":"t","url":"https://x.org","tags":[],"order":0,"visits":3,"lastVisit":1700000000}]}]}`
	out, _, err := parseAndValidate([]byte(ok))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"visits": 3`) {
		t.Fatalf("visits lost: %s", out)
	}
	bad := strings.Replace(ok, `"visits":3`, `"visits":-1`, 1)
	var ve *ValidationError
	if _, _, err := parseAndValidate([]byte(bad)); !errors.As(err, &ve) {
		t.Fatalf("negative visits accepted: %v", err)
	}
}
