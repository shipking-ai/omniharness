package policy

import (
	"context"
	"strings"
	"testing"

	"omniharness/internal/tools"
)

func permissive() *Engine {
	return NewEngine(Config{
		RiskAction:   map[string]string{"low": "allow", "medium": "allow", "high": "allow", "critical": "block"},
		ShellAllowed: true,
	}, nil)
}

// A risk class is a blunt instrument. An operator who sets high = "allow" to
// stop being asked about shell has not thereby agreed to spend money, hand
// over a credential, or destroy something unprompted.
func TestGatedEffectsOverrideAPermissiveRiskTable(t *testing.T) {
	e := permissive()
	for _, effect := range []tools.Effect{
		tools.EffectDestructive, tools.EffectFinancial,
		tools.EffectCredential, tools.EffectRequiresConfirmation,
	} {
		d, reason, err := e.Evaluate(context.Background(), Request{
			Tool: "t", Risk: tools.RiskLow, Effects: []tools.Effect{effect},
		})
		if err != nil {
			t.Fatal(err)
		}
		if d != Ask {
			t.Errorf("effect %s under an allow-everything table gave %s, want ask", effect, d)
		}
		if !strings.Contains(reason, "t") {
			t.Errorf("reason %q does not name the tool", reason)
		}
	}
}

// Effects that are not gated must not start prompting: read_only and external
// describe a tool, they do not demand a decision.
func TestUngatedEffectsDoNotPrompt(t *testing.T) {
	e := permissive()
	for _, effect := range []tools.Effect{tools.EffectReadOnly, tools.EffectExternal} {
		d, _, err := e.Evaluate(context.Background(), Request{
			Tool: "t", Risk: tools.RiskLow, Effects: []tools.Effect{effect},
		})
		if err != nil {
			t.Fatal(err)
		}
		if d != Allow {
			t.Errorf("effect %s gave %s, want allow", effect, d)
		}
	}
	// And no effects at all behaves exactly as before effects existed.
	if d, _, _ := e.Evaluate(context.Background(), Request{Tool: "t", Risk: tools.RiskLow}); d != Allow {
		t.Errorf("a tool with no effects gave %s, want allow", d)
	}
}

// A gated effect may only ever make the outcome stricter. It must never talk a
// block down to a prompt.
func TestGatedEffectsNeverWeakenABlock(t *testing.T) {
	e := NewEngine(Config{
		RiskAction: map[string]string{"low": "block", "medium": "ask", "high": "ask", "critical": "block"},
	}, nil)
	d, _, err := e.Evaluate(context.Background(), Request{
		Tool: "t", Risk: tools.RiskLow, Effects: []tools.Effect{tools.EffectFinancial},
	})
	if err != nil {
		t.Fatal(err)
	}
	if d != Block {
		t.Fatalf("a blocked risk class with a financial effect gave %s, want block", d)
	}
	// A blocked tool list still wins too.
	blocked := NewEngine(Config{
		RiskAction:   map[string]string{"low": "allow", "medium": "allow", "high": "allow", "critical": "block"},
		BlockedTools: []string{"t"},
	}, nil)
	if d, _, _ := blocked.Evaluate(context.Background(), Request{
		Tool: "t", Risk: tools.RiskLow, Effects: []tools.Effect{tools.EffectFinancial},
	}); d != Block {
		t.Errorf("a blocked tool with an effect gave %s, want block", d)
	}
}

// The reason a human reads has to say what kind of thing they are approving,
// in words rather than identifiers.
func TestGatedReasonIsReadable(t *testing.T) {
	e := permissive()
	_, reason, _ := e.Evaluate(context.Background(), Request{
		Tool: "mcp:blender:generate_hyper3d_model_via_text",
		Risk: tools.RiskLow, Effects: []tools.Effect{tools.EffectFinancial},
	})
	if !strings.Contains(reason, "spend money") {
		t.Errorf("reason %q does not explain the financial effect in plain words", reason)
	}
	_, reason, _ = e.Evaluate(context.Background(), Request{
		Tool: "process_kill", Risk: tools.RiskLow,
		Effects: []tools.Effect{tools.EffectDestructive, tools.EffectFinancial},
	})
	if !strings.Contains(reason, "and") {
		t.Errorf("two effects read as %q; they should be joined", reason)
	}
}

// The vocabulary is closed on purpose: policy branches on these names, so one
// it does not know could not be enforced.
func TestEffectVocabularyIsClosed(t *testing.T) {
	if err := tools.ValidateEffect("financail"); err == nil {
		t.Fatal("a misspelled effect was accepted; the gate would be silently lost")
	}
	if err := tools.ValidateEffect(tools.EffectFinancial); err != nil {
		t.Errorf("a known effect was rejected: %v", err)
	}
	if _, err := tools.ParseEffects([]string{"read_only", "nope"}); err == nil {
		t.Error("ParseEffects accepted an unknown name")
	}
}

// process_kill is the one native tool that cannot be undone.
func TestNativeDestructiveToolIsDeclared(t *testing.T) {
	r := tools.NewRegistry()
	if err := tools.NewNative(t.TempDir()).Register(r); err != nil {
		t.Fatal(err)
	}
	kill, ok := r.Get("process_kill")
	if !ok {
		t.Fatal("process_kill is not registered")
	}
	if !kill.Spec().HasEffect(tools.EffectDestructive) {
		t.Error("process_kill is not declared destructive; a killed process does not come back")
	}
	// An edited file is recoverable, so write_file must not claim to be.
	write, _ := r.Get("write_file")
	if write.Spec().HasEffect(tools.EffectDestructive) {
		t.Error("write_file is declared destructive; a changed file is recoverable")
	}
	read, _ := r.Get("read_file")
	if !read.Spec().HasEffect(tools.EffectReadOnly) {
		t.Error("read_file is not declared read-only")
	}
}
