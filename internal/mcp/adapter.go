package mcp

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"omniharness/internal/tools"
)

// ToolAdapter adapts an MCP tool to the tools.Tool interface so MCP tools
// flow through the same registry and policy engine as native tools.
type ToolAdapter struct {
	Client *Client
	Info   ToolInfo
	// ArtifactDir is where binary tool output (images, PDFs) is written.
	// Empty means nowhere: such content is then described but not saved.
	ArtifactDir string
}

// Spec returns the structured metadata. MCP tools run code in the server's
// context, so they are conservatively classified high risk.
func (a *ToolAdapter) Spec() tools.Spec {
	params := a.Info.InputSchema
	if params == nil {
		params = map[string]any{"type": "object", "properties": map[string]any{}}
	}
	risk := tools.RiskHigh
	return tools.Spec{
		Name:         ToolName(a.Client.server.Name, a.Info.Name),
		Description:  a.Info.Description,
		Parameters:   params,
		Risk:         risk,
		Capabilities: a.capabilities(),
		Provider:     ProviderName(a.Client.server.Name),
		ExecutesCode: true,
	}
}

// capabilities reports what the operator declared for this server, always
// including CapExternalTool.
//
// The declared names are for discovery: they let a planner ask "can anything
// here render a scene?" and get an answer. They are deliberately NOT the
// access grant. No role declares "render_scene" — nothing in core knows what
// Blender is, which is the point — so treating a declaration as the grant
// made a well-described server unreachable while an undescribed one worked.
// Describing your server better must never make it less usable.
//
// CapExternalTool is what the acting roles match on, so reach is the same
// either way and restriction stays where it belongs: policy, which gates on
// risk and on explicit allow/block lists.
//
// Invalid names were already rejected at config load; anything that still
// fails validation here is dropped rather than handed to the registry, so a
// programmatically-constructed Server cannot inject a malformed capability.
func (a *ToolAdapter) capabilities() []tools.Capability {
	declared := a.Client.server.Capabilities
	out := make([]tools.Capability, 0, len(declared)+1)
	for _, raw := range declared {
		c := tools.Capability(strings.TrimSpace(raw))
		if tools.ValidateCapability(c) != nil || c == tools.CapExternalTool {
			continue
		}
		out = append(out, c)
	}
	return append(out, tools.CapExternalTool)
}

// ValidateCapabilities checks every capability an operator declared for a
// server. A typo here would otherwise be silent and expensive: the adapter
// drops the unusable name, the tool registers with no matching capability,
// and no role can ever reach it — a working server that simply never gets
// used. Callers validate before starting the process so the failure names the
// config line rather than appearing as an absence.
func ValidateCapabilities(s Server) error {
	for _, raw := range s.Capabilities {
		c := tools.Capability(strings.TrimSpace(raw))
		if err := tools.ValidateCapability(c); err != nil {
			return fmt.Errorf("mcp server %q: %w", s.Name, err)
		}
	}
	return nil
}

// ProviderName labels an MCP server in tools.Spec.Provider.
func ProviderName(server string) string { return "mcp:" + server }

// Run invokes the MCP tool.
func (a *ToolAdapter) Run(ctx context.Context, input map[string]any) (tools.Result, error) {
	// A server that has gone away is a different situation from a tool that
	// ran and failed: the model should stop calling it rather than retry.
	if !a.Client.Alive() {
		return tools.Result{}, &tools.Error{
			Kind:    tools.ErrUnavailable,
			Tool:    a.Spec().Name,
			Message: "the MCP server is no longer running",
		}
	}
	result, err := a.Client.CallTool(ctx, a.Info.Name, input)
	if err != nil {
		kind := tools.ErrFailed
		if !a.Client.Alive() {
			kind = tools.ErrUnavailable
		} else if ctx.Err() != nil {
			kind = tools.ErrTimeout
		}
		return tools.Result{}, &tools.Error{Kind: kind, Tool: a.Spec().Name, Message: err.Error()}
	}
	output, artifacts, images := a.renderContent(result.Content)
	if len(artifacts) > 0 {
		return tools.Result{Output: output, Artifact: true, Artifacts: artifacts, Images: images}, nil
	}
	if result.IsError {
		// The server ran the tool and reported failure — ordinary, and the
		// model can reasonably act on it.
		return tools.Result{Output: output}, &tools.Error{
			Kind: tools.ErrFailed, Tool: a.Spec().Name, Message: output,
		}
	}
	return tools.Result{Output: output}, nil
}

// renderContent turns MCP content blocks into text the model can read, plus
// the paths of anything that had to be written to disk.
//
// Not every block is text. A viewport screenshot comes back as an image
// block carrying base64 data, and reading only the text blocks turned that
// into an empty string with no error — the agent saw a successful call that
// returned nothing, which is exactly the observe step of an observe/evaluate
// loop failing silently. Binary content is written to the artifact directory
// and described by path and size, so the agent knows what exists and where.
// The tool-result channel is text, so the bytes themselves do not reach the
// model here; a path it can act on is the honest thing to hand back.
func (a *ToolAdapter) renderContent(blocks []Content) (string, []string, []tools.Image) {
	var b strings.Builder
	var artifacts []string
	var images []tools.Image
	write := func(s string) {
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString(s)
	}
	for i, c := range blocks {
		switch {
		case c.Type == "text":
			write(c.Text)
		case c.Resource != nil && c.Resource.Text != "":
			write(c.Resource.Text)
		default:
			data, mime := c.Data, c.MimeType
			if c.Resource != nil && data == "" {
				data, mime = c.Resource.Blob, c.Resource.MimeType
			}
			if data == "" {
				write(fmt.Sprintf("[%s content, empty]", blockLabel(c.Type)))
				continue
			}
			raw, err := base64.StdEncoding.DecodeString(data)
			if err != nil {
				write(fmt.Sprintf("[%s content that could not be decoded: %v]", blockLabel(c.Type), err))
				continue
			}
			path, err := a.saveBlob(raw, mime, i)
			if err != nil {
				write(fmt.Sprintf("[%s content, %d bytes, %s — could not be saved: %v]",
					blockLabel(c.Type), len(raw), mimeOrUnknown(mime), err))
				continue
			}
			artifacts = append(artifacts, path)
			if strings.HasPrefix(strings.ToLower(mime), "image/") {
				images = append(images, tools.Image{Path: path, MimeType: mime})
			}
			write(fmt.Sprintf("[%s content, %d bytes, %s] saved to %s",
				blockLabel(c.Type), len(raw), mimeOrUnknown(mime), path))
		}
	}
	return b.String(), artifacts, images
}

// saveBlob writes binary content under the adapter's artifact directory.
// Without a directory configured there is nowhere to put it, and the caller
// reports the content rather than pretending it was stored.
func (a *ToolAdapter) saveBlob(raw []byte, mime string, index int) (string, error) {
	if a.ArtifactDir == "" {
		return "", errors.New("no artifact directory is configured")
	}
	if err := os.MkdirAll(a.ArtifactDir, 0o755); err != nil {
		return "", err
	}
	name := fmt.Sprintf("%s-%s-%d%s",
		sanitize(a.Client.server.Name), sanitize(a.Info.Name),
		time.Now().UnixNano()+int64(index), extensionFor(mime))
	path := filepath.Join(a.ArtifactDir, name)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func blockLabel(t string) string {
	if t == "" {
		return "binary"
	}
	return t
}

func mimeOrUnknown(m string) string {
	if m == "" {
		return "unknown type"
	}
	return m
}

// extensionFor maps the handful of mime types an MCP server realistically
// returns. An unknown type keeps .bin rather than guessing.
func extensionFor(mime string) string {
	switch strings.ToLower(strings.TrimSpace(mime)) {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "application/pdf":
		return ".pdf"
	case "application/json":
		return ".json"
	case "text/plain":
		return ".txt"
	}
	return ".bin"
}

// sanitize keeps a name safe to use as a path segment.
func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		}
		return '-'
	}, s)
}
