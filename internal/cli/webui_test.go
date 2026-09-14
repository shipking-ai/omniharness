package cli

import (
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func TestEveryWebUIRouteResolvesToAnEmbeddedFile(t *testing.T) {
	srv := httptest.NewServer(webUIHandler())
	defer srv.Close()

	for path, file := range webUIRoutes {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body := make([]byte, 64)
		n, _ := resp.Body.Read(body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s served %s: %d, want 200 — the embed directive and the route table disagree",
				path, file.path, resp.StatusCode)
			continue
		}
		if n == 0 {
			t.Errorf("GET %s served %s empty", path, file.path)
		}
		if got := resp.Header.Get("Content-Type"); got != file.contentType {
			t.Errorf("GET %s served Content-Type %q, want %q", path, got, file.contentType)
		}
	}
}

// assetRef finds the local files a page pulls in: <script src>, <link href>.
// Absolute URLs are not matched because there are none — every asset comes
// from the binary, which is the property this test is really protecting.
var assetRef = regexp.MustCompile(`(?:src|href)="(/[^"]+)"`)

// TestEveryAssetAPageReferencesIsRouted is the one that catches a broken UI.
//
// A missing script tag route does not fail loudly: the page loads, the browser
// fetches /desktop.js, gets the handler's 404, and the surface is a static
// shell with no behaviour at all. Nothing in a Go test suite would otherwise
// notice, because the Go side is perfectly happy.
func TestEveryAssetAPageReferencesIsRouted(t *testing.T) {
	pages := []string{"webui/index.html", "webui/desktop.html"}
	for _, page := range pages {
		raw, err := webUI.ReadFile(page)
		if err != nil {
			t.Fatalf("read %s: %v", page, err)
		}
		matches := assetRef.FindAllStringSubmatch(string(raw), -1)
		if len(matches) == 0 {
			t.Errorf("%s references no assets at all; either the page lost its scripts or this test's pattern is wrong", page)
		}
		for _, m := range matches {
			ref := m[1]
			if _, ok := webUIRoutes[ref]; !ok {
				t.Errorf("%s references %s, which webUIRoutes does not serve; "+
					"the page would load and then silently do nothing", page, ref)
			}
		}
	}
}

// The two surfaces must stay two surfaces: / is the web view and /desktop is
// the shell, and serving one where the other belongs is the failure mode of a
// route table edited by hand.
func TestTheTwoSurfacesAreDistinct(t *testing.T) {
	srv := httptest.NewServer(webUIHandler())
	defer srv.Close()

	get := func(path string) string {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		return string(body)
	}

	web, desktop := get("/"), get("/desktop")
	if web == desktop {
		t.Fatal("/ and /desktop serve the same document; the desktop window would open the web view")
	}
	if !strings.Contains(desktop, "/desktop.js") {
		t.Error("/desktop does not load desktop.js")
	}
	if !strings.Contains(web, "/app.js") {
		t.Error("/ does not load app.js")
	}
	for _, page := range []string{web, desktop} {
		if !strings.Contains(page, "/core.js") {
			t.Error("a surface does not load core.js; it would have its own copy of the client")
		}
	}
}

// A flex column shrinks its children by default. The session rail is a flex
// column holding one button per session, and without flex:none each row was
// compressed below the height of its own text once the list outgrew the rail —
// the labels overlapped into an unreadable smear instead of the list
// scrolling. It looked like a rendering glitch and it was a one-word CSS bug.
//
// Asserted on the stylesheet because there is no DOM to measure here; the
// point is that the declaration cannot be dropped again without a test saying
// so.
func TestScrollingListsDoNotShrinkTheirRows(t *testing.T) {
	// Each entry is a rule that must carry flex:none, on each page that has it.
	shrinkable := []string{".session{", ".new-run{", ".rail-label{", ".rail-foot{"}

	for _, page := range []string{"webui/index.html", "webui/desktop.html"} {
		raw, err := webUI.ReadFile(page)
		if err != nil {
			t.Fatalf("read %s: %v", page, err)
		}
		css := string(raw)
		for _, rule := range shrinkable {
			at := strings.Index(css, rule)
			if at < 0 {
				t.Errorf("%s has no %s rule; this test is checking a selector that no longer exists", page, rule)
				continue
			}
			end := strings.Index(css[at:], "}")
			if end < 0 {
				t.Errorf("%s: %s rule is never closed", page, rule)
				continue
			}
			if !strings.Contains(css[at:at+end], "flex:none") {
				t.Errorf("%s: %s is a child of a flex column and does not set flex:none; "+
					"it will be squashed below its content height when the rail overflows", page, rule)
			}
		}
	}
}
