package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The file API is the one route that can hand out a file, so escaping the
// workspace root is the failure that matters. These go through the HTTP
// handlers rather than the resolver directly, because the handler is what an
// attacker reaches and a route wired to the wrong root would pass a
// resolver-level test.
func TestFileAPIRefusesToLeaveTheWorkspace(t *testing.T) {
	// The secret sits in the workspace's own parent, so "../secret.txt" is a
	// path a naive filepath.Join actually reaches. Putting it in an unrelated
	// temp directory made every escape 404 on its own, and the test passed
	// against a completely unconfined handler.
	base := t.TempDir()
	root := filepath.Join(base, "workspace")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "inside.txt"), []byte("visible"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(base, "secret.txt")
	if err := os.WriteFile(outside, []byte("must not be served"), 0o600); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(fsFileHandler(root))
	defer srv.Close()

	get := func(path string) (int, string) {
		resp, err := http.Get(srv.URL + "?path=" + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer resp.Body.Close()
		var body strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := resp.Body.Read(buf)
			body.Write(buf[:n])
			if err != nil {
				break
			}
		}
		return resp.StatusCode, body.String()
	}

	if code, body := get("inside.txt"); code != http.StatusOK || !strings.Contains(body, "visible") {
		t.Fatalf("a file inside the workspace was not served: %d %s", code, body)
	}

	for _, escape := range []string{
		"../secret.txt",
		"../../secret.txt",
		"subdir/../../secret.txt",
		filepath.ToSlash(outside),
	} {
		code, body := get(escape)
		if code == http.StatusOK {
			t.Errorf("path %q was served with %d — the workspace root did not hold", escape, code)
		}
		if strings.Contains(body, "must not be served") {
			t.Errorf("path %q leaked the contents of a file outside the workspace", escape)
		}
	}
}

// A directory listing is a disclosure too: names alone tell an attacker what
// exists. The tree handler must refuse the same paths the file handler does.
func TestTreeAPIRefusesToLeaveTheWorkspace(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "workspace")
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "sibling.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(fsTreeHandler(root))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "?path=..")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Errorf("listing the workspace's parent returned %d, want a refusal", resp.StatusCode)
	}
}

// .git holds every version of every file the repository has ever had. Walking
// into it from an explorer is both useless and a way to read content that is
// not in the working tree.
func TestTreeSkipsDirectoriesNobodyOpenedTheExplorerToFind(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{".git", "node_modules", "internal"} {
		if err := os.Mkdir(filepath.Join(root, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	srv := httptest.NewServer(fsTreeHandler(root))
	defer srv.Close()

	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Entries []fsEntry `json:"entries"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, e := range body.Entries {
		seen[e.Name] = true
	}
	if !seen["internal"] {
		t.Error("an ordinary directory is missing from the listing")
	}
	for _, hidden := range []string{".git", "node_modules"} {
		if seen[hidden] {
			t.Errorf("%s was listed", hidden)
		}
	}
}

// An empty WorkspaceRoot means "unconfined" to ResolveInWorkspace, which is a
// reasonable default for a tool the operator ran themselves and a serious one
// for an HTTP route: it would let anything that satisfies the loopback guard
// read any file on the machine. The routes must never be wired that way.
func TestFileRoutesAreNeverUnconfined(t *testing.T) {
	if got := fsRoot(""); got == "" {
		t.Fatal("fsRoot returned an empty root, which ResolveInWorkspace treats as no confinement at all")
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Skip("no working directory")
	}
	if got := fsRoot(""); got != cwd {
		t.Errorf("fsRoot(\"\") = %q, want the working directory %q", got, cwd)
	}
	if got := fsRoot("/explicit"); got != "/explicit" {
		t.Errorf("fsRoot overrode an explicitly configured root: %q", got)
	}
}
