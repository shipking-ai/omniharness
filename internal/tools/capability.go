package tools

import (
	"fmt"
	"sort"
	"strings"
)

// Capability names what a tool can do, independent of which program provides
// it. It exists so a role — or a planner — can ask "what here can execute
// code?" rather than "was I built knowing about this tool's name?". Two tools
// from different providers that declare the same capability are
// interchangeable to a caller that only needs the capability.
//
// The vocabulary is deliberately OPEN. Core validates the shape of a name, not
// its membership in a list: an adapter for a program this build has never
// heard of must be able to declare "create_3d_scene" without a change here.
// Constants below cover only what tools in this repository actually provide;
// nothing is declared for capabilities no tool implements.
type Capability string

// Capabilities provided by the native tools.
const (
	CapReadFiles      Capability = "read_files"      // read file contents, list directories
	CapWriteFiles     Capability = "write_files"     // create, overwrite or edit files
	CapSearchCode     Capability = "search_code"     // find files, search contents
	CapExecuteCode    Capability = "execute_code"    // run arbitrary commands
	CapVersionControl Capability = "version_control" // git operations
	CapInspectProcess Capability = "inspect_process" // list or signal processes
	CapManageMemory   Capability = "manage_memory"   // durable project notes
	CapPlanControl    Capability = "plan_control"    // ask the harness to restructure execution
)

// CapExternalTool is the fallback capability for an adapter whose provider
// declared nothing more specific. It means only "this came from outside the
// harness"; it says nothing about what the tool does, which is why an operator
// who wants narrow reach should declare real capabilities instead.
const CapExternalTool Capability = "external_tool"

// ValidateCapability checks a capability name's shape: lowercase ASCII
// letters, digits and underscores, starting with a letter. It deliberately
// does not check the name against a known list — see Capability.
func ValidateCapability(c Capability) error {
	s := string(c)
	if s == "" {
		return fmt.Errorf("capability name is empty")
	}
	if s[0] < 'a' || s[0] > 'z' {
		return fmt.Errorf("capability %q must start with a lowercase letter", s)
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
		default:
			return fmt.Errorf("capability %q may only contain lowercase letters, digits and underscores", s)
		}
	}
	return nil
}

// ParseCapabilities converts and validates a list of raw names, reporting the
// first invalid one. Used by config loading so a typo fails at startup rather
// than silently making a tool unreachable.
func ParseCapabilities(raw []string) ([]Capability, error) {
	out := make([]Capability, 0, len(raw))
	for _, s := range raw {
		c := Capability(strings.TrimSpace(s))
		if err := ValidateCapability(c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

// SortCapabilities returns a sorted copy, for stable output.
func SortCapabilities(in []Capability) []Capability {
	out := append([]Capability(nil), in...)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
