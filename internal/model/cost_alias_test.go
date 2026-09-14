package model

import "testing"

// A routing alias carries no pricing information, and EstimateCost falls back
// to blended mid-tier rates when a name matches nothing. That fallback is a
// guess presented as a figure: it happens to equal Sonnet's rate, so a routed
// Sonnet call looked correct and hid the problem, while Haiku was priced
// several times too high and Opus several times too low.
//
// Callers must therefore price the model the gateway actually used, never the
// alias they asked for. This test pins the size of the error being avoided.
func TestAliasPricingDivergesFromTheResolvedModel(t *testing.T) {
	const in, out = 1_000_000, 1_000_000

	alias := EstimateCost("auto/best-fast", in, out)
	haiku := EstimateCost("anthropic/claude-haiku-4.5", in, out)
	if alias == haiku {
		t.Fatalf("alias and Haiku both priced at %v; the fallback no longer diverges, so this test proves nothing", alias)
	}
	// 3.0 + 15.0 blended, against Haiku's 0.8 + 4.0.
	if alias != 18.0 || haiku != 4.8 {
		t.Errorf("alias = %v (want 18), haiku = %v (want 4.8)", alias, haiku)
	}

	opus := EstimateCost("anthropic/claude-opus-5", in, out)
	if opus <= alias {
		t.Errorf("opus = %v, alias = %v; pricing an Opus call off the alias under-reports it", opus, alias)
	}
}
