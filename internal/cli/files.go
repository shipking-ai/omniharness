package cli

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"omniharness/internal/tools"
)

// maxFileBytes is the most this API will read out of one file.
//
// The editor is for source, and a source file that runs past this is not one
// somebody is reading — it is a lockfile, a bundle or a fixture. Reading it
// whole would stall the window on a synchronous read and then hand the browser
// a string it cannot lay out.
const maxFileBytes = 2 << 20

// skipDirs never appear in the tree. Both are enormous, neither is ever what
// somebody opened the explorer to find, and walking them makes the first
// expansion of a repository root feel broken.
var skipDirs = map[string]bool{".git": true, "node_modules": true}

// fsRoot is the directory the file routes are confined to.
//
// WorkspaceRoot is empty unless --workspace or the config file sets it, and
// ResolveInWorkspace treats an empty root as "no confinement" — which is a
// defensible default for a tool the operator invoked directly, and completely
// wrong for an HTTP route. Unconfined here would mean any page that satisfies
// the loopback guard could read any file on the machine. The working directory
// is both the safe answer and the one the --workspace flag already documents
// as its default.
func fsRoot(configured string) string {
	if configured != "" {
		return configured
	}
	cwd, err := os.Getwd()
	if err != nil {
		// Nothing sensible is left. An empty root would be unconfined, so
		// refuse everything instead: the routes fail closed on a directory
		// that does not exist.
		return filepath.Join(string(filepath.Separator), "omniharness-no-workspace")
	}
	return cwd
}

// fsEntry is one row in the explorer.
type fsEntry struct {
	Name string `json:"name"`
	Path string `json:"path"` // relative to the workspace root, slash-separated
	Dir  bool   `json:"dir"`
	Size int64  `json:"size,omitempty"`
}

// fsTreeHandler lists one directory.
//
// One directory rather than the whole tree: a repository has more files than
// anyone wants delivered at once, and lazily expanding a folder is both faster
// and how every file explorer already behaves.
//
// Confinement is not this file's own idea of what is safe. It calls the same
// resolver the filesystem tools use, so the explorer can never show a file the
// agent itself is forbidden to touch — and a fix to one is a fix to both.
func fsTreeHandler(workspaceRoot string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		abs, err := tools.ResolveInWorkspace(workspaceRoot, r.URL.Query().Get("path"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		items, err := os.ReadDir(abs)
		if err != nil {
			http.Error(w, "cannot read that directory", http.StatusNotFound)
			return
		}

		root := workspaceRoot
		if root == "" {
			root = abs
		}
		entries := make([]fsEntry, 0, len(items))
		for _, item := range items {
			if item.IsDir() && skipDirs[item.Name()] {
				continue
			}
			full := filepath.Join(abs, item.Name())
			rel, err := filepath.Rel(root, full)
			if err != nil {
				continue
			}
			e := fsEntry{Name: item.Name(), Path: filepath.ToSlash(rel), Dir: item.IsDir()}
			if info, err := item.Info(); err == nil && !item.IsDir() {
				e.Size = info.Size()
			}
			entries = append(entries, e)
		}
		// Directories first, then case-insensitive by name: the order every
		// file explorer uses, and the one a reader scans without thinking.
		sort.Slice(entries, func(i, j int) bool {
			if entries[i].Dir != entries[j].Dir {
				return entries[i].Dir
			}
			return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
		})
		writeJSON(w, http.StatusOK, map[string]any{
			"root":    filepath.ToSlash(root),
			"path":    filepath.ToSlash(mustRel(root, abs)),
			"entries": entries,
		})
	}
}

func mustRel(root, p string) string {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return "."
	}
	return rel
}

// fsFileHandler returns one file's text.
func fsFileHandler(workspaceRoot string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		raw := r.URL.Query().Get("path")
		if raw == "" {
			http.Error(w, "path is required", http.StatusBadRequest)
			return
		}
		abs, err := tools.ResolveInWorkspace(workspaceRoot, raw)
		if err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		info, err := os.Stat(abs)
		if err != nil || info.IsDir() {
			http.Error(w, "cannot read that file", http.StatusNotFound)
			return
		}

		f, err := os.Open(abs)
		if err != nil {
			http.Error(w, "cannot read that file", http.StatusNotFound)
			return
		}
		defer f.Close()
		buf := make([]byte, maxFileBytes)
		n, _ := f.Read(buf)
		buf = buf[:n]

		// A NUL byte inside what claims to be text means it is not text.
		// Handing a browser the bytes of an executable renders as pages of
		// replacement characters and looks like a bug in the editor rather
		// than a file nobody should have opened.
		if !utf8.Valid(buf) || indexNUL(buf) >= 0 {
			writeJSON(w, http.StatusOK, map[string]any{
				"path":   filepath.ToSlash(raw),
				"binary": true,
				"size":   info.Size(),
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"path":      filepath.ToSlash(raw),
			"content":   string(buf),
			"size":      info.Size(),
			"truncated": info.Size() > int64(n),
			"language":  languageOf(raw),
		})
	}
}

func indexNUL(b []byte) int {
	for i, c := range b {
		if c == 0 {
			return i
		}
	}
	return -1
}

// languageOf names the highlighter the viewer should use. The extension is the
// only signal available without reading the file, and it is right often enough
// that sniffing content would add failure modes for no gain.
func languageOf(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".go":
		return "go"
	case ".js", ".mjs", ".cjs", ".jsx":
		return "js"
	case ".ts", ".tsx":
		return "ts"
	case ".json":
		return "json"
	case ".py":
		return "python"
	case ".rs":
		return "rust"
	case ".sh", ".bash":
		return "shell"
	case ".css":
		return "css"
	case ".html", ".htm":
		return "html"
	case ".md", ".markdown":
		return "markdown"
	case ".toml":
		return "toml"
	case ".yaml", ".yml":
		return "yaml"
	default:
		return "text"
	}
}
