Wails requires an embedded asset directory. This one is deliberately empty.

Every asset the application serves comes from `internal/cli/webui`, compiled
into the binary by the same `go:embed` the `serve` command uses, and is handed
to the webview through an `http.Handler` rather than an asset bundle. Two
copies of the front-end — one here for the application and one there for the
server — is exactly the drift this arrangement exists to prevent.
