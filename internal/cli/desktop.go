package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// browserCandidates are the Chromium-family browsers that support app mode, in
// the order they are tried. Firefox and Safari are absent on purpose: neither
// has an equivalent of --app, so they would open a normal tabbed window and the
// result would not be a desktop app in any sense a user would recognise.
func browserCandidates() []string {
	switch runtime.GOOS {
	case "windows":
		return []string{
			`C:\Program Files\Google\Chrome\Application\chrome.exe`,
			`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
			`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
			`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
			"chrome.exe", "msedge.exe", "brave.exe",
		}
	case "darwin":
		return []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		}
	default:
		return []string{
			"google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
			"microsoft-edge", "brave-browser",
		}
	}
}

// findBrowser returns the first candidate that exists on this machine.
func findBrowser() (string, error) {
	for _, c := range browserCandidates() {
		if strings.ContainsAny(c, `/\`) {
			if info, err := os.Stat(c); err == nil && !info.IsDir() {
				return c, nil
			}
			continue
		}
		if p, err := exec.LookPath(c); err == nil {
			return p, nil
		}
	}
	return "", errors.New("no Chromium-family browser found (Chrome, Edge, Brave or Chromium)")
}

// desktopArgs builds the app-mode command line.
//
// --app is what makes this a window rather than a tab: no address bar, no tab
// strip, its own entry in the dock or taskbar. The separate --user-data-dir
// gives it a profile of its own, so it neither inherits the user's cookies and
// extensions nor disturbs a browser they already have open — which also means
// launching it does not steal focus from their existing windows.
func desktopArgs(url, profileDir string, width, height int) []string {
	return []string{
		"--app=" + url,
		"--user-data-dir=" + profileDir,
		fmt.Sprintf("--window-size=%d,%d", width, height),
		"--no-first-run",
		"--no-default-browser-check",
	}
}

func newDesktopCmd() *cobra.Command {
	var (
		port          int
		width, height int
	)
	cmd := &cobra.Command{
		Use:   "desktop",
		Short: "Open the harness in a desktop window",
		Long: `Starts the local server and opens the browser UI in its own window.

This is a real window — no address bar, no tab strip, its own taskbar entry —
backed by a Chromium-family browser already on the machine, running against a
profile of its own so it does not touch the one you browse with.

What it deliberately is not is a bundled runtime. Shipping Electron would add
roughly 150MB to a binary whose whole promise is that it is one file, and
docs/architecture.md rules it out. Using the browser that is already installed
costs nothing and behaves the same.

Needs Chrome, Edge, Brave or Chromium. Without one, use ` + "`omniharness serve`" + `
and open the printed URL, or stay in the terminal with ` + "`omniharness`" + `.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			browser, err := findBrowser()
			if err != nil {
				return fmt.Errorf("%w; run `omniharness serve` and open the URL it prints instead", err)
			}
			url := fmt.Sprintf("http://127.0.0.1:%d/", port)
			profile, err := desktopProfileDir()
			if err != nil {
				return err
			}

			ctx, stop := context.WithCancel(cmd.Context())
			defer stop()

			// The server runs in this process: closing the window should not
			// leave a harness listening on a port nobody is watching.
			serveErr := make(chan error, 1)
			go func() { serveErr <- runServer(ctx, port) }()

			if err := waitForServer(ctx, url, 20*time.Second); err != nil {
				stop()
				return err
			}

			fmt.Printf("omniharness desktop · %s\n", url)
			win := exec.CommandContext(ctx, browser, desktopArgs(url, profile, width, height)...)
			if err := win.Start(); err != nil {
				stop()
				return fmt.Errorf("open the window: %w", err)
			}

			// Whichever ends first ends the other: closing the window shuts the
			// server down, and a server that dies takes the window with it.
			done := make(chan error, 1)
			go func() { done <- win.Wait() }()
			select {
			case <-done:
				stop()
				return nil
			case err := <-serveErr:
				return err
			case <-ctx.Done():
				return nil
			}
		},
	}
	cmd.Flags().IntVar(&port, "port", 20140, "loopback port")
	cmd.Flags().IntVar(&width, "width", 1280, "window width")
	cmd.Flags().IntVar(&height, "height", 860, "window height")
	return cmd
}

// desktopProfileDir is where the window keeps its own browser profile.
//
// Separate from the user's everyday profile on purpose: the harness window
// should not inherit their cookies, extensions or sessions, and opening it
// should not disturb a browser they already have running.
func desktopProfileDir() (string, error) {
	cfg, err := loadConfig()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(cfg.Persistence.Dir, "desktop-profile")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create the window profile directory: %w", err)
	}
	return dir, nil
}

// waitForServer blocks until the local server answers, so the window is never
// opened on a connection-refused page.
func waitForServer(ctx context.Context, url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: time.Second}
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"health", nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil {
			resp.Body.Close()
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the local server did not start within %s: %w", timeout, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(150 * time.Millisecond):
		}
	}
}
