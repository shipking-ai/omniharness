package tui

import (
	"strings"
	"testing"

	"omniharness/internal/event"
)

// A provider dying mid-run narrows what the agent can still do. It does not
// fail the task, so nothing else stops to announce it — which is exactly why
// the TUI has to: the run carries on with fewer tools and the reason would
// otherwise never reach the person watching.
func TestProviderLostIsVisible(t *testing.T) {
	m, _ := newTestModel(t)
	e := event.New(&event.ProviderLostData{
		Provider: "mcp:blender",
		Reason:   "the MCP server process ended",
		Tools:    []string{"mcp:blender:render", "mcp:blender:get_scene_info"},
	})
	e.SessionID = m.sessionID
	m.applyEvent(e)

	var found string
	for _, line := range m.conversation {
		if strings.Contains(line.Text, "mcp:blender") {
			found = line.Text
		}
	}
	if found == "" {
		t.Fatal("losing a provider produced no visible line")
	}
	if !strings.Contains(found, "2 tool") {
		t.Errorf("line %q does not say how much was lost", found)
	}
	if !strings.Contains(found, "process ended") {
		t.Errorf("line %q does not say why", found)
	}
	if len(m.lostProviders) != 1 || m.lostProviders[0] != "mcp:blender" {
		t.Errorf("lostProviders = %v, want [mcp:blender]", m.lostProviders)
	}
}

// The capabilities view answers "what can this run actually do?". With an
// external provider the tool names are generated at runtime, so a list of
// names answers nothing; the capability is the question.
func TestCapabilitiesOverlayListsCapabilitiesNotJustNames(t *testing.T) {
	m, _ := newTestModel(t)
	out := m.renderCapabilitiesOverlay()

	// The native tools are always registered, so their capabilities must show.
	for _, want := range []string{"read_files", "execute_code", "write_files"} {
		if !strings.Contains(out, want) {
			t.Errorf("capabilities view does not mention %q:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "shell") {
		t.Errorf("capabilities view does not name the tool providing execute_code:\n%s", out)
	}
}

// A provider that died is not the same as one that was never configured, and
// the view must not let the reader confuse the two.
func TestCapabilitiesOverlayReportsLostProviders(t *testing.T) {
	m, _ := newTestModel(t)
	if strings.Contains(m.renderCapabilitiesOverlay(), "lost during this session") {
		t.Fatal("the view claims a loss before anything was lost")
	}
	m.lostProviders = append(m.lostProviders, "mcp:blender")
	out := m.renderCapabilitiesOverlay()
	if !strings.Contains(out, "lost during this session") || !strings.Contains(out, "mcp:blender") {
		t.Errorf("a lost provider is not reported:\n%s", out)
	}
}

// The shortcut has to be discoverable, or a view behind a key is a view
// nobody opens.
func TestHelpListsTheCapabilitiesShortcut(t *testing.T) {
	m, _ := newTestModel(t)
	help := m.renderHelpOverlay()
	if !strings.Contains(help, "Ctrl+T") {
		t.Errorf("help does not mention the capabilities shortcut:\n%s", help)
	}
}
