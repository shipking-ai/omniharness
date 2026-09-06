package mcp

import (
	"context"
	"fmt"
	"strings"

	"omniharness/internal/tools"
)

// ToolAdapter adapts an MCP tool to the tools.Tool interface so MCP tools
// flow through the same registry and policy engine as native tools.
type ToolAdapter struct {
	Client *Client
	Info   ToolInfo
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

// capabilities reports what the operator declared for this server. Invalid
// names were already rejected at config load; anything that still fails
// validation here is dropped rather than handed to the registry, so a
// programmatically-constructed Server cannot inject a malformed capability.
// A server that declares nothing gets CapExternalTool, which is what makes an
// MCP tool reachable at all: without it no role's capability set would match,
// and the tool would register but never be offered to a model.
func (a *ToolAdapter) capabilities() []tools.Capability {
	declared := a.Client.server.Capabilities
	out := make([]tools.Capability, 0, len(declared))
	for _, raw := range declared {
		c := tools.Capability(strings.TrimSpace(raw))
		if tools.ValidateCapability(c) != nil {
			continue
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return []tools.Capability{tools.CapExternalTool}
	}
	return out
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
	var b strings.Builder
	for _, c := range result.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
			b.WriteString("\n")
		}
	}
	output := strings.TrimSuffix(b.String(), "\n")
	if result.IsError {
		// The server ran the tool and reported failure — ordinary, and the
		// model can reasonably act on it.
		return tools.Result{Output: output}, &tools.Error{
			Kind: tools.ErrFailed, Tool: a.Spec().Name, Message: output,
		}
	}
	return tools.Result{Output: output}, nil
}
