package tools

import (
	"fmt"
	"sort"
	"strings"
)

// Effect declares a consequence of running a tool, beyond how dangerous it is.
// Risk answers "how bad could this be"; effects answer "what kind of thing is
// it", and the two are not the same question. Spending money is not
// necessarily high risk, and a high-risk tool is not necessarily irreversible.
//
// Absence is meaningful: a tool with no EffectDestructive is one whose work
// can be undone, which is why there is no explicit "reversible" — a flag
// nothing branches on is a flag that drifts out of date.
type Effect string

const (
	// EffectReadOnly: observes without changing anything. Declaring it is a
	// promise, not a hint — policy may treat these more leniently.
	EffectReadOnly Effect = "read_only"
	// EffectDestructive: the change cannot be undone from inside the harness.
	// Deleting, killing, force-pushing. Distinct from merely mutating: an
	// edited file is recoverable, a killed process is not.
	EffectDestructive Effect = "destructive"
	// EffectExternal: reaches something off this machine.
	EffectExternal Effect = "external"
	// EffectFinancial: spends money. Real: blender-mcp's asset generation
	// tools bill third-party APIs, and nothing about their risk class says so.
	EffectFinancial Effect = "financial"
	// EffectCredential: handles secrets. Such a tool must never run without a
	// human seeing the request.
	EffectCredential Effect = "credential"
	// EffectRequiresConfirmation: the operator wants this asked about, whatever
	// the risk table says. An escape hatch for a tool only they understand.
	EffectRequiresConfirmation Effect = "requires_confirmation"
)

// gatedEffects are the effects that force a confirmation prompt no matter how
// permissive the risk table is. A risk class is a blunt instrument: an
// operator who sets high = "allow" to stop being asked about shell has not
// thereby agreed to spend money or hand over a credential unprompted.
func gatedEffects() []Effect {
	return []Effect{EffectDestructive, EffectFinancial, EffectCredential, EffectRequiresConfirmation}
}

// KnownEffects lists every effect this build understands, in declaration
// order. Unlike capabilities the vocabulary is closed: policy has to branch on
// these, and a name it does not know could not be enforced — silently
// accepting one would let a provider declare "financial" as "financail" and
// quietly lose the gate.
func KnownEffects() []Effect {
	return []Effect{
		EffectReadOnly, EffectDestructive, EffectExternal,
		EffectFinancial, EffectCredential, EffectRequiresConfirmation,
	}
}

// ValidateEffect checks a name against the known set.
func ValidateEffect(e Effect) error {
	for _, known := range KnownEffects() {
		if known == e {
			return nil
		}
	}
	names := make([]string, 0, len(KnownEffects()))
	for _, k := range KnownEffects() {
		names = append(names, string(k))
	}
	return fmt.Errorf("unknown effect %q (known: %s)", e, strings.Join(names, ", "))
}

// ParseEffects converts and validates raw names, reporting the first bad one.
func ParseEffects(raw []string) ([]Effect, error) {
	out := make([]Effect, 0, len(raw))
	for _, s := range raw {
		e := Effect(strings.TrimSpace(s))
		if err := ValidateEffect(e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

// HasEffect reports whether a spec declares an effect.
func (s Spec) HasEffect(e Effect) bool {
	for _, have := range s.Effects {
		if have == e {
			return true
		}
	}
	return false
}

// GatedEffects returns the declared effects that force confirmation, sorted so
// the reason given to a human is stable between runs.
func (s Spec) GatedEffects() []Effect {
	var out []Effect
	for _, g := range gatedEffects() {
		if s.HasEffect(g) {
			out = append(out, g)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
