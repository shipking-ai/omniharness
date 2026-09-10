// Command omniharness-app is the OmniHarness desktop application.
//
// This is a real application, not a browser pointed at a local server. It
// installs, it has an icon, it appears in the launcher, and it opens with a
// double click. What it is not is Electron: the window is the operating
// system's own webview — WebView2 on Windows, WebKit on macOS and Linux — so
// the whole thing is a handful of megabytes rather than a bundled copy of
// Chromium and Node.
package main

import (
	"context"
	"embed"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"omniharness/internal/cli"
)

// Wails refuses to start without an index.html it can find. Nothing in here is
// ever served; see the file itself.
//
//go:embed all:frontend
var frontend embed.FS

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// A real socket, on a port the operating system picks.
	//
	// Mounting the API handler straight into the webview's asset server was
	// the obvious design and it does not work: Server-Sent Events need a
	// ResponseWriter that flushes, the asset server does not provide one, and
	// the stream failed while the gateway sat there connected — the window
	// showed "reconnecting" forever. The event stream is the spine of this
	// interface, so it gets a transport that can carry it.
	//
	// Port 0 rather than a fixed number: two windows on one machine must not
	// fight over a port, and a hardcoded one is also a hardcoded target.
	port, err := freePort()
	if err != nil {
		fail(err)
	}
	go func() {
		if err := cli.Serve(ctx, port); err != nil {
			fmt.Fprintf(os.Stderr, "omniharness: %v\n", err)
		}
	}()

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	if err := waitFor(ctx, base+"/health", 25*time.Second); err != nil {
		fail(err)
	}

	err = wails.Run(&options.App{
		Title:  "OmniHarness",
		Width:  1440,
		Height: 940,
		// Small enough to be useful on a laptop half-screen, large enough that
		// three panes are still three panes.
		MinWidth:  980,
		MinHeight: 620,
		AssetServer: &assetserver.Options{
			Assets:     frontend,
			Middleware: redirectToApp(base),
		},
		// The window paints before the first frame of the page does. Matching
		// the application's own canvas means the gap reads as the app starting
		// rather than as a white flash.
		BackgroundColour: &options.RGBA{R: 8, G: 9, B: 11, A: 1},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
		},
		OnShutdown: func(context.Context) { cancel() },
	})
	if err != nil {
		fail(err)
	}
}

// redirectToApp sends the webview at the real server.
//
// Wails has no option for opening a window on a URL, so the one page its asset
// server ever answers is a redirect to the application proper. Everything
// after that — the page, its assets, the API and the event stream — is
// ordinary HTTP against loopback, which means the rebinding guard applies
// unchanged and the window is exactly the client the API documents.
func redirectToApp(base string) assetserver.Middleware {
	return func(http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, base+"/app", http.StatusTemporaryRedirect)
		})
	}
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// waitFor blocks until the server answers, so the window never opens on a
// connection-refused page.
func waitFor(ctx context.Context, url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: time.Second}
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		if resp, err := client.Do(req); err == nil {
			resp.Body.Close()
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the harness did not start within %s", timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(120 * time.Millisecond):
		}
	}
}

// fail reports before any window exists. A double-clicked application has no
// console, so the exit code is what a launcher will notice.
func fail(err error) {
	fmt.Fprintf(os.Stderr, "omniharness: %v\n", err)
	os.Exit(1)
}
