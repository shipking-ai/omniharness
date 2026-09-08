package model

import (
	"strings"
	"testing"
)

func selectorWith(t *testing.T, supports map[string][]string) *Selector {
	t.Helper()
	s := NewSelector("p/default", map[string]string{CapCoding: "p/coder"})
	if err := s.SetSupports(supports); err != nil {
		t.Fatalf("SetSupports: %v", err)
	}
	return s
}

// The vocabulary is closed because selection branches on these names. A
// misspelling that validated would quietly mean "no requirement".
func TestPropertyVocabularyIsClosed(t *testing.T) {
	s := NewSelector("p/m", nil)
	if err := s.SetSupports(map[string][]string{"p/m": {"vison"}}); err == nil {
		t.Fatal("a misspelled property was accepted")
	}
	if err := s.SetSupports(map[string][]string{"p/m": {"vision", "tools"}}); err != nil {
		t.Fatalf("known properties were rejected: %v", err)
	}
	if err := s.SetSupports(map[string][]string{"not-a-ref": {"vision"}}); err == nil {
		t.Fatal("a malformed model reference was accepted")
	}
}

// Silence is not a claim: an undeclared model supports nothing.
func TestUndeclaredModelSupportsNothing(t *testing.T) {
	s := selectorWith(t, map[string][]string{"p/seer": {"vision"}})
	if s.Supports("p/coder", PropVision) {
		t.Error("an undeclared model reports vision support")
	}
	if !s.Supports("p/seer", PropVision) {
		t.Error("a declared model does not report its property")
	}
	if got := s.Supporting(PropVision); len(got) != 1 || got[0] != "p/seer" {
		t.Errorf("Supporting(vision) = %v, want [p/seer]", got)
	}
	if got := s.Supporting(PropLocal); len(got) != 0 {
		t.Errorf("Supporting(local) = %v, want nothing", got)
	}
}

// A required property is not a preference. Using a model that cannot do the
// thing produces a confident wrong answer: a model that cannot see does not
// say so, it guesses.
func TestRequiredPropertyOverridesTheConfiguredChoice(t *testing.T) {
	s := selectorWith(t, map[string][]string{"p/seer": {"vision"}})
	got, reason, err := s.ResolveExplain(Intent{
		Capabilities: []string{CapCoding},
		Requires:     []Property{PropVision},
	})
	if err != nil {
		t.Fatalf("ResolveExplain: %v", err)
	}
	if got != "p/seer" {
		t.Fatalf("resolved %q, want p/seer — the coding model cannot see", got)
	}
	if !strings.Contains(reason, "p/coder") || !strings.Contains(reason, "vision") {
		t.Errorf("reason %q does not explain the substitution", reason)
	}
}

// When the configured choice already qualifies, nothing is substituted.
func TestNoSubstitutionWhenTheChoiceQualifies(t *testing.T) {
	s := selectorWith(t, map[string][]string{"p/coder": {"vision", "tools"}})
	got, reason, err := s.ResolveExplain(Intent{
		Capabilities: []string{CapCoding},
		Requires:     []Property{PropVision},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != "p/coder" {
		t.Fatalf("resolved %q, want the configured p/coder", got)
	}
	if strings.Contains(reason, "does not support") {
		t.Errorf("reason %q claims a substitution that did not happen", reason)
	}
}

// Requiring something nothing can do must be an error, not a silent fallback
// to a model that cannot do it.
func TestUnsatisfiableRequirementIsAnError(t *testing.T) {
	s := selectorWith(t, map[string][]string{"p/coder": {"tools"}})
	_, _, err := s.ResolveExplain(Intent{Requires: []Property{PropVision}})
	if err == nil {
		t.Fatal("an unsatisfiable requirement resolved to something")
	}
	if !strings.Contains(err.Error(), "models.supports") {
		t.Errorf("error %q does not say how to fix it", err)
	}
}

// Several requirements must all hold, not any of them.
func TestAllRequirementsMustHold(t *testing.T) {
	s := selectorWith(t, map[string][]string{
		"p/seer":  {"vision"},
		"p/both":  {"vision", "tools"},
		"p/coder": {"tools"},
	})
	got, _, err := s.ResolveExplain(Intent{Requires: []Property{PropVision, PropTools}})
	if err != nil {
		t.Fatal(err)
	}
	if got != "p/both" {
		t.Errorf("resolved %q, want p/both — the only model with both", got)
	}
}

// No requirements at all behaves exactly as it did before properties existed.
func TestNoRequirementsIsUnchanged(t *testing.T) {
	s := selectorWith(t, map[string][]string{"p/seer": {"vision"}})
	got, _, err := s.ResolveExplain(Intent{Capabilities: []string{CapCoding}})
	if err != nil {
		t.Fatal(err)
	}
	if got != "p/coder" {
		t.Errorf("resolved %q, want the configured p/coder", got)
	}
}
