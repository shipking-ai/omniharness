package strategy

import (
	"testing"

	"omniharness/internal/task"
)

func TestCreativeDomainSelectsIterateStrategy(t *testing.T) {
	in := Input{Profile: task.Profile{
		Domain: task.DomainCreative, Complexity: task.ComplexityMedium,
		Ambiguity: task.LevelLow, Risk: task.LevelLow, Verification: task.VerificationNone,
	}}
	got, _ := Selector{}.Select(in)
	if got.Strategy != CreativeIterate {
		t.Fatalf("strategy = %s, want %s (reason: %s)", got.Strategy, CreativeIterate, got.Reason)
	}
	if len(got.Steps) != 3 {
		t.Fatalf("got %d steps, want brief/make/judge", len(got.Steps))
	}
	if got.Steps[0].Role != "creative-director" || got.Steps[1].Role != "asset-producer" || got.Steps[2].Role != "creative-director" {
		t.Fatalf("roles = %s/%s/%s, want director, producer, director",
			got.Steps[0].Role, got.Steps[1].Role, got.Steps[2].Role)
	}
	// The judge step must depend on the make step, or it judges nothing.
	if len(got.Steps[2].Depends) != 1 || got.Steps[2].Depends[0] != got.Steps[1].ID {
		t.Errorf("the judge step does not depend on the make step: %+v", got.Steps[2])
	}
	if got.Steps[1].Depends == nil {
		t.Error("the make step does not depend on the brief")
	}
}

// A small creative request must not get a three-agent ceremony.
func TestSimpleCreativeTaskStaysDirect(t *testing.T) {
	in := Input{Profile: task.Profile{
		Domain: task.DomainCreative, Complexity: task.ComplexityLow,
		Ambiguity: task.LevelLow, Risk: task.LevelLow, Verification: task.VerificationNone,
	}}
	got, _ := Selector{}.Select(in)
	if got.Strategy != Direct {
		t.Errorf("strategy = %s, want direct for a low-complexity creative task", got.Strategy)
	}
}

// Adding a creative branch must not have diverted software work.
func TestSoftwareRoutingIsUnaffected(t *testing.T) {
	in := Input{Profile: task.Profile{
		Domain: task.DomainSoftware, Complexity: task.ComplexityHigh,
		Ambiguity: task.LevelLow, Risk: task.LevelLow, Verification: task.VerificationNone,
	}}
	got, _ := Selector{}.Select(in)
	if got.Strategy == CreativeIterate {
		t.Fatal("a software task was routed to the creative strategy")
	}
	for _, s := range got.Steps {
		if s.Role == "creative-director" || s.Role == "asset-producer" {
			t.Errorf("a software plan used creative role %q", s.Role)
		}
	}
}
