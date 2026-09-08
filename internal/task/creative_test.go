package task

import "testing"

func TestCreativeDomainDetection(t *testing.T) {
	a := &Analyzer{}
	creative := []string{
		"Make a cinematic sci-fi opening shot",
		"Render the scene with softer lighting and a lower camera angle",
		"Color grade the footage to feel colder",
		"Create a 2-minute instrumental with three beat switches",
		"Fix the composition of this 3d scene",
	}
	for _, prompt := range creative {
		p := a.Analyze(Spec{Prompt: prompt})
		if p.Domain != DomainCreative {
			t.Errorf("Analyze(%q).Domain = %s, want CREATIVE", prompt, p.Domain)
		}
	}
}

// Domain detection must not start pulling ordinary software work into the
// creative branch just because a word overlaps.
func TestCreativeKeywordsDoNotHijackSoftwareTasks(t *testing.T) {
	a := &Analyzer{}
	software := map[string]Domain{
		"Fix the failing test in the parser and refactor the function": DomainSoftware,
		"Debug the nil pointer exception in the handler":               DomainSoftware,
		"Add a database migration for the users table":                 DomainData,
	}
	for prompt, want := range software {
		if got := a.Analyze(Spec{Prompt: prompt}).Domain; got != want {
			t.Errorf("Analyze(%q).Domain = %s, want %s", prompt, got, want)
		}
	}
}
