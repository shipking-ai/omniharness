package cli

import (
	"embed"
	"net/http"
)

// webUI is the browser front-end, compiled into the binary.
//
// Embedded rather than served from a directory, and written without a CDN or a
// bundler, so `omniharness serve` stays one file you can copy to a machine with
// no network and still get a UI. That is the same promise the TUI makes; a web
// front-end that needed the internet to draw itself would not be the same
// product.
//
//go:embed webui/index.html webui/app.js
var webUI embed.FS

// webUIFile is one embedded asset and the type to serve it as.
type webUIFile struct {
	path        string
	contentType string
}

// webUIRoutes is the whole front-end: two files, listed explicitly.
//
// Explicit rather than an http.FileServer for two reasons. A FileServer
// redirects /index.html back to / and turns the page into a 301 hop, and its
// directory handling is surface this server does not need. More importantly a
// catch-all would answer unknown paths with HTML — so a typo'd /v1/ call would
// come back 200 with a page in it, which a client parses as JSON and reports as
// a confusing error far from the cause.
var webUIRoutes = map[string]webUIFile{
	"/":           {"webui/index.html", "text/html; charset=utf-8"},
	"/index.html": {"webui/index.html", "text/html; charset=utf-8"},
	"/app.js":     {"webui/app.js", "application/javascript; charset=utf-8"},
}

// webUIHandler serves the front-end, and nothing else.
func webUIHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		file, ok := webUIRoutes[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := webUI.ReadFile(file.path)
		if err != nil {
			// Only reachable if the embed directive and this table disagree,
			// which is a build mistake rather than a runtime condition.
			http.Error(w, "web ui not built into this binary", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", file.contentType)
		// Generated fresh by a binary that changes every release, served over
		// loopback where caching buys nothing and a stale UI costs confusion.
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.Write(body)
	})
}
