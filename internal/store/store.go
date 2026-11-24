package store

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrPreconditionFailed is returned when If-Match does not match the current ETag.
var ErrPreconditionFailed = errors.New("the data has been changed in the meantime (ETag does not match)")

// BackupInterval is the minimum age of the newest backup before a save creates another one.
const BackupInterval = time.Hour

// InvalidFileError reports a data file on disk that is not a valid document.
type InvalidFileError struct {
	Path string
	Err  error
}

func (e *InvalidFileError) Error() string {
	return fmt.Sprintf("data file %s is invalid: %v", e.Path, e.Err)
}

// Store persists the bookmark document as a JSON file.
type Store struct {
	mu             sync.Mutex
	path           string
	backupDir      string
	maxBackups     int
	backupInterval time.Duration
	now            func() time.Time
}

// Open uses the data file at path, creating it with example data if it is
// missing, and keeps up to maxBackups rotating backups next to it. An existing
// invalid file does not make Open fail; Load and Save report it.
func Open(path string, maxBackups int) (*Store, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if maxBackups < 0 {
		maxBackups = 0
	}
	s := &Store{
		path:           abs,
		backupDir:      filepath.Join(filepath.Dir(abs), "backups"),
		maxBackups:     maxBackups,
		backupInterval: BackupInterval,
		now:            time.Now,
	}
	var ife *InvalidFileError
	if _, _, err := s.Load(); err != nil && !errors.As(err, &ife) {
		return nil, err
	}
	return s, nil
}

// Path returns the absolute path of the data file.
func (s *Store) Path() string { return s.path }

func computeETag(b []byte) string {
	sum := sha256.Sum256(b)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

// etagMatches compares an If-Match header value against the current ETag.
// It accepts a comma-separated list, weak prefixes and unquoted values.
func etagMatches(header, current string) bool {
	cur := strings.Trim(current, `"`)
	for _, part := range strings.Split(header, ",") {
		p := strings.TrimSpace(part)
		p = strings.TrimPrefix(p, "W/")
		if p == "*" || strings.Trim(p, `"`) == cur {
			return true
		}
	}
	return false
}

// Load re-reads the data file (picking up external edits) and returns its
// bytes and ETag. A missing file is initialized with example data.
func (s *Store) Load() ([]byte, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

func (s *Store) readLocked() ([]byte, string, error) {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		out, merr := marshalData(defaultData())
		if merr != nil {
			return nil, "", merr
		}
		if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
			return nil, "", err
		}
		if err := atomicWrite(s.path, out); err != nil {
			return nil, "", err
		}
		return out, computeETag(out), nil
	}
	if err != nil {
		return nil, "", err
	}
	if _, _, err := parseAndValidate(b); err != nil {
		return nil, "", &InvalidFileError{Path: s.path, Err: err}
	}
	return b, computeETag(b), nil
}

// Save validates raw, checks ifMatch against the current file's ETag, backs up
// the current file and writes the normalized data atomically.
func (s *Store) Save(ifMatch string, raw []byte) ([]byte, string, error) {
	out, _, err := parseAndValidate(raw)
	if err != nil {
		return nil, "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, cur, err := s.readLocked()
	if err != nil {
		return nil, "", err
	}
	if !etagMatches(ifMatch, cur) {
		return nil, "", ErrPreconditionFailed
	}
	if err := s.backupLocked(); err != nil {
		return nil, "", fmt.Errorf("backup: %w", err)
	}
	if err := atomicWrite(s.path, out); err != nil {
		return nil, "", err
	}
	return out, computeETag(out), nil
}

func atomicWrite(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmpName, path); err != nil {
		return err
	}
	return syncDir(dir)
}

// syncDir makes a completed rename durable across a power loss. Windows cannot
// open directories for syncing.
func syncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

const backupStampLayout = "20060102-150405"

var backupNameRe = regexp.MustCompile(`^bookmarks-(\d{8}-\d{6})(?:-(\d+))?\.json$`)

func (s *Store) backupLocked() error {
	if s.maxBackups == 0 {
		return nil
	}
	if recent, err := s.recentBackupLocked(); err != nil || recent {
		return err
	}
	src, err := os.Open(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer src.Close()
	if err := os.MkdirAll(s.backupDir, 0o700); err != nil {
		return err
	}
	stamp := s.now().Format(backupStampLayout)
	var dst *os.File
	for i := 0; ; i++ {
		name := "bookmarks-" + stamp + ".json"
		if i > 0 {
			name = fmt.Sprintf("bookmarks-%s-%d.json", stamp, i)
		}
		dst, err = os.OpenFile(filepath.Join(s.backupDir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			break
		}
		if !errors.Is(err, fs.ErrExist) || i > 10000 {
			return err
		}
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		os.Remove(dst.Name())
		return err
	}
	if err := dst.Close(); err != nil {
		return err
	}
	return s.rotateLocked()
}

// recentBackupLocked reports whether the newest backup is younger than the
// backup interval.
func (s *Store) recentBackupLocked() (bool, error) {
	if s.backupInterval <= 0 {
		return false, nil
	}
	list, err := s.listBackups()
	if errors.Is(err, fs.ErrNotExist) || (err == nil && len(list) == 0) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	now := s.now()
	t, err := time.ParseInLocation(backupStampLayout, list[0].stamp, now.Location())
	if err != nil {
		return false, nil
	}
	return now.Sub(t) < s.backupInterval, nil
}

type backupEntry struct {
	name  string
	stamp string
	seq   int
}

func (s *Store) listBackups() ([]backupEntry, error) {
	entries, err := os.ReadDir(s.backupDir)
	if err != nil {
		return nil, err
	}
	var list []backupEntry
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		m := backupNameRe.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		seq := 0
		if m[2] != "" {
			seq, _ = strconv.Atoi(m[2])
		}
		list = append(list, backupEntry{name: e.Name(), stamp: m[1], seq: seq})
	}
	// newest first
	sort.Slice(list, func(i, j int) bool {
		if list[i].stamp != list[j].stamp {
			return list[i].stamp > list[j].stamp
		}
		return list[i].seq > list[j].seq
	})
	return list, nil
}

func (s *Store) rotateLocked() error {
	list, err := s.listBackups()
	if err != nil {
		return err
	}
	for i := s.maxBackups; i < len(list); i++ {
		if err := os.Remove(filepath.Join(s.backupDir, list[i].name)); err != nil {
			return err
		}
	}
	return nil
}
