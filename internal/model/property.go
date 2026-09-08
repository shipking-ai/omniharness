package model

import (
	"fmt"
	"sort"
	"strings"
)

// Property is a fact about what a model can do, declared per model.
//
// This is the opposite direction from the capability map. `[models.capabilities]`
// answers "for reasoning, which model?" — intent to model. Properties answer
// "what can this model do?" — model to facts. Both are needed and they are not
// interchangeable: a run may be on a coding model and still need to know
// whether that particular model can accept an image.
//
// They have to be declared. OmniRoute's catalog reports id, name and provider
// with nothing about modality, context window or tool support, so none of this
// is discoverable and the harness will not guess.
//
// Measured facts are deliberately absent. Latency and cost are not declarations
// — performance memory records them from real runs, which is a better source
// than an operator's estimate and cannot go stale the same way.
type Property string

const (
	// PropVision: accepts image input.
	PropVision Property = "vision"
	// PropTools: calls tools reliably. Some models accept a tool list and
	// then narrate instead of calling.
	PropTools Property = "tools"
	// PropStructuredOutput: returns valid JSON against a schema reliably.
	PropStructuredOutput Property = "structured_output"
	// PropLongContext: takes a large context window without degrading.
	PropLongContext Property = "long_context"
	// PropLocal: runs on this machine, so nothing leaves it. The one property
	// that is about where the model is rather than what it can do, and the
	// reason it matters is data handling rather than quality.
	PropLocal Property = "local"
)

// KnownProperties lists every property this build understands. The vocabulary
// is closed: selection branches on these, and a name it does not know could
// not be honoured — accepting one silently would let "vison" quietly mean
// "no requirement".
func KnownProperties() []Property {
	return []Property{PropVision, PropTools, PropStructuredOutput, PropLongContext, PropLocal}
}

// ValidateProperty checks a name against the known set.
func ValidateProperty(p Property) error {
	for _, known := range KnownProperties() {
		if known == p {
			return nil
		}
	}
	names := make([]string, 0, len(KnownProperties()))
	for _, k := range KnownProperties() {
		names = append(names, string(k))
	}
	return fmt.Errorf("unknown model property %q (known: %s)", p, strings.Join(names, ", "))
}

// SetSupports declares what each configured model can do, keyed by
// provider/model reference. Replaces any previous declaration. An unknown
// property name is an error rather than a silent no-op.
func (s *Selector) SetSupports(raw map[string][]string) error {
	next := make(map[string][]Property, len(raw))
	refs := make([]string, 0, len(raw))
	for ref := range raw {
		refs = append(refs, ref)
	}
	sort.Strings(refs) // stable error for a config with several mistakes
	for _, ref := range refs {
		if err := ValidateRef(ref); err != nil {
			return fmt.Errorf("models.supports: %w", err)
		}
		for _, name := range raw[ref] {
			p := Property(strings.TrimSpace(string(name)))
			if err := ValidateProperty(p); err != nil {
				return fmt.Errorf("models.supports[%q]: %w", ref, err)
			}
			next[ref] = append(next[ref], p)
		}
	}
	s.supports = next
	return nil
}

// Supports reports whether a model is declared to have a property. An
// undeclared model supports nothing: silence is not a claim.
func (s *Selector) Supports(ref string, p Property) bool {
	for _, have := range s.supports[ref] {
		if have == p {
			return true
		}
	}
	return false
}

// Supporting returns every configured model declared to have the property, in
// a stable order.
func (s *Selector) Supporting(p Property) []string {
	var out []string
	for ref := range s.supports {
		if s.Supports(ref, p) {
			out = append(out, ref)
		}
	}
	sort.Strings(out)
	return out
}

// satisfies reports whether a model has every required property.
func (s *Selector) satisfies(ref string, required []Property) bool {
	for _, p := range required {
		if !s.Supports(ref, p) {
			return false
		}
	}
	return true
}
