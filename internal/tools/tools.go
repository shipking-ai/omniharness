// Package tools defines the tool system: a registry of native tools, MCP
// tools and plugin tools, each exposing structured metadata (name, description,
// JSON input schema, risk level, execution characteristics). All tool
// execution flows through the policy engine before it runs.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Risk classifies the danger of a tool invocation.
type Risk string

const (
	RiskLow      Risk = "low"
	RiskMedium   Risk = "medium"
	RiskHigh     Risk = "high"
	RiskCritical Risk = "critical"
)

// AllRisks lists risk classes in ascending severity.
func AllRisks() []Risk { return []Risk{RiskLow, RiskMedium, RiskHigh, RiskCritical} }

// Spec is the structured metadata of a tool.
type Spec struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"` // JSON schema
	Risk        Risk           `json:"risk"`
	// Capabilities are what this tool provides, independent of its name. A
	// caller that needs "execute_code" can find every tool that offers it
	// without knowing which program implements them. Empty means the tool is
	// reachable by name only.
	Capabilities []Capability `json:"capabilities,omitempty"`
	// Effects declare what kind of thing the tool does — irreversible, costs
	// money, handles credentials — which Risk does not capture. Policy gates
	// some of them regardless of the risk table; see effect.go.
	Effects []Effect `json:"effects,omitempty"`
	// Version is the provider's own version string, when it reports one —
	// "BlenderMCP 1.29.1". A bug report against a tool is close to useless
	// without it, and the provider is the only thing that knows.
	Version string `json:"version,omitempty"`
	// Provider names where the tool came from — "native" for built-ins, or
	// "mcp:<server>" for an MCP adapter. Observability only; nothing routes
	// on it.
	Provider string `json:"provider,omitempty"`
	// MutatesFS reports whether the tool can change files on disk.
	MutatesFS bool `json:"mutatesFs,omitempty"`
	// ExecutesCode reports whether the tool runs arbitrary commands/code.
	ExecutesCode bool `json:"executesCode,omitempty"`
	// Network reports whether the tool can reach the network.
	Network bool `json:"network,omitempty"`
}

// Result of a tool invocation.
type Result struct {
	Output string `json:"output"`
	// Artifact marks outputs worth persisting (files produced, etc.).
	Artifact bool `json:"artifact,omitempty"`
	// Artifacts lists paths the tool itself produced. Artifact alone only
	// covers the case where the caller already named the path in the input;
	// a tool that decides where its output lands — an external tool handing
	// back an image, say — has to be able to say so.
	Artifacts []string `json:"artifacts,omitempty"`
	// Images are the subset of Artifacts a vision-capable model could be
	// shown. Named explicitly rather than inferred from file extensions: a
	// tool knows the media type it produced, and guessing it back from a
	// suffix is how a .bin of unknown content ends up sent to a model.
	Images []Image `json:"images,omitempty"`
	// Replan marks that this call is a request to restructure the task's
	// execution — the agent that ran it has decided the current plan is too
	// small for what it has actually found. The caller (agent.Agent) records
	// the reason (Output); the orchestrator acts on it once the current step
	// finishes.
	Replan bool `json:"replan,omitempty"`
}

// Image is an image a tool produced, on disk and ready to show a model that
// can accept one.
type Image struct {
	Path     string `json:"path"`
	MimeType string `json:"mimeType"`
}

// Tool is the execution interface.
type Tool interface {
	Spec() Spec
	Run(ctx context.Context, input map[string]any) (Result, error)
}

// Registry holds every available tool.
type Registry struct {
	mu    sync.RWMutex
	tools map[string]Tool
}

// NewRegistry creates an empty registry.
func NewRegistry() *Registry {
	return &Registry{tools: make(map[string]Tool)}
}

// Register adds a tool. Duplicate names are an error.
func (r *Registry) Register(t Tool) error {
	s := t.Spec()
	if s.Name == "" {
		return fmt.Errorf("tool with empty name")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.tools[s.Name]; exists {
		return fmt.Errorf("tool %q already registered", s.Name)
	}
	r.tools[s.Name] = t
	return nil
}

// Unregister removes a tool by name, reporting whether it was present. A tool
// whose provider has gone away must leave the registry: left in place it is
// still offered to models, and every call to it fails.
func (r *Registry) Unregister(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.tools[name]; !ok {
		return false
	}
	delete(r.tools, name)
	return true
}

// UnregisterProvider removes every tool from one provider (see Spec.Provider)
// and returns the removed names, sorted. This is the whole-server case: an MCP
// process that dies takes all of its tools with it, and the caller needs the
// names to report what was lost.
func (r *Registry) UnregisterProvider(provider string) []string {
	if provider == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var removed []string
	for name, t := range r.tools {
		if t.Spec().Provider == provider {
			removed = append(removed, name)
			delete(r.tools, name)
		}
	}
	sort.Strings(removed)
	return removed
}

// WithProvider returns the specs registered by one provider, sorted by name.
func (r *Registry) WithProvider(provider string) []Spec {
	if provider == "" {
		return nil
	}
	var out []Spec
	for _, s := range r.List() {
		if s.Provider == provider {
			out = append(out, s)
		}
	}
	return out
}

// Get returns a tool by name.
func (r *Registry) Get(name string) (Tool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.tools[name]
	return t, ok
}

// List returns all tool specs, sorted by name.
func (r *Registry) List() []Spec {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Spec, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, t.Spec())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// WithCapability returns the specs of every registered tool that declares the
// capability, sorted by name. This is the discovery path: a caller asks what
// can do a thing, not which program does it.
func (r *Registry) WithCapability(c Capability) []Spec {
	var out []Spec
	for _, s := range r.List() {
		if specHasCapability(s, c) {
			out = append(out, s)
		}
	}
	return out
}

// HasCapability reports whether any registered tool provides the capability.
func (r *Registry) HasCapability(c Capability) bool {
	for _, s := range r.List() {
		if specHasCapability(s, c) {
			return true
		}
	}
	return false
}

// Capabilities returns every capability provided by at least one registered
// tool, deduplicated and sorted. The set changes as adapters register, so this
// is computed on demand rather than cached.
func (r *Registry) Capabilities() []Capability {
	seen := map[Capability]bool{}
	var out []Capability
	for _, s := range r.List() {
		for _, c := range s.Capabilities {
			if !seen[c] {
				seen[c] = true
				out = append(out, c)
			}
		}
	}
	return SortCapabilities(out)
}

func specHasCapability(s Spec, c Capability) bool {
	for _, have := range s.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}

// Names returns tool names only.
func (r *Registry) Names() []string {
	specs := r.List()
	out := make([]string, len(specs))
	for i, s := range specs {
		out[i] = s.Name
	}
	return out
}

// ToGatewaySpecs converts registry specs to gateway tool specs for the model.
func (r *Registry) ToGatewaySpecs() []GatewaySpec {
	specs := r.List()
	out := make([]GatewaySpec, 0, len(specs))
	for _, s := range specs {
		out = append(out, GatewaySpec{Name: s.Name, Description: s.Description, Parameters: s.Parameters})
	}
	return out
}

// GatewaySpec is the model-facing tool description.
type GatewaySpec struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// DecodeArgs decodes a JSON-encoded argument string into a map.
func DecodeArgs(raw string) (map[string]any, error) {
	var m map[string]any
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}, nil
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("invalid tool arguments: %w", err)
	}
	return m, nil
}

// StringArg extracts a string argument.
func StringArg(input map[string]any, key string) (string, error) {
	v, ok := input[key]
	if !ok {
		return "", fmt.Errorf("missing required argument %q", key)
	}
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("argument %q must be a string", key)
	}
	return s, nil
}

// BoolArg extracts an optional boolean argument.
func BoolArg(input map[string]any, key string, def bool) bool {
	v, ok := input[key]
	if !ok {
		return def
	}
	b, ok := v.(bool)
	if !ok {
		return def
	}
	return b
}
