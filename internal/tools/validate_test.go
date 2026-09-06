package tools

import (
	"errors"
	"strings"
	"testing"
)

func objSchema(props map[string]any, required ...string) map[string]any {
	out := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		out["required"] = required
	}
	return out
}

func decode(t *testing.T, raw string) map[string]any {
	t.Helper()
	m, err := DecodeArgs(raw)
	if err != nil {
		t.Fatalf("DecodeArgs(%s): %v", raw, err)
	}
	return m
}

func TestValidateInputRequiredArguments(t *testing.T) {
	spec := Spec{Name: "read_file", Parameters: objSchema(map[string]any{
		"path": map[string]any{"type": "string"},
	}, "path")}

	err := ValidateInput(spec, decode(t, `{}`))
	if err == nil {
		t.Fatal("a call missing a required argument was accepted")
	}
	if !strings.Contains(err.Error(), "path") {
		t.Errorf("error %q does not name the missing argument", err)
	}
	if KindOf(err) != ErrInvalidInput {
		t.Errorf("kind = %s, want %s", KindOf(err), ErrInvalidInput)
	}
	if err := ValidateInput(spec, decode(t, `{"path":"a.go"}`)); err != nil {
		t.Errorf("a valid call was rejected: %v", err)
	}
}

func TestValidateInputTypes(t *testing.T) {
	spec := Spec{Name: "t", Parameters: objSchema(map[string]any{
		"path":  map[string]any{"type": "string"},
		"limit": map[string]any{"type": "integer"},
		"ratio": map[string]any{"type": "number"},
		"force": map[string]any{"type": "boolean"},
		"args":  map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
	})}
	ok := []string{
		`{"path":"a"}`, `{"limit":5}`, `{"ratio":1.5}`, `{"ratio":2}`,
		`{"force":true}`, `{"args":["a","b"]}`, `{}`,
		`{"path":null}`, // an explicit null means "not supplied"
	}
	for _, in := range ok {
		if err := ValidateInput(spec, decode(t, in)); err != nil {
			t.Errorf("ValidateInput(%s) = %v, want nil", in, err)
		}
	}
	bad := []string{
		`{"path":5}`, `{"limit":"5"}`, `{"limit":1.5}`, `{"force":"yes"}`,
		`{"args":"a"}`, `{"args":[1]}`, `{"ratio":"x"}`,
	}
	for _, in := range bad {
		if err := ValidateInput(spec, decode(t, in)); err == nil {
			t.Errorf("ValidateInput(%s) = nil, want a type error", in)
		}
	}
}

// additionalProperties:false means the argument set is closed, and naming the
// stray argument is what lets a model correct a near-miss.
func TestValidateInputRejectsUnexpectedArguments(t *testing.T) {
	spec := Spec{Name: "t", Parameters: objSchema(map[string]any{
		"path": map[string]any{"type": "string"},
	})}
	err := ValidateInput(spec, decode(t, `{"path":"a","filename":"b"}`))
	if err == nil {
		t.Fatal("an undeclared argument was accepted")
	}
	if !strings.Contains(err.Error(), "filename") || !strings.Contains(err.Error(), "path") {
		t.Errorf("error %q should name both the stray argument and what is allowed", err)
	}
}

// An open schema must stay open: a server that does not set
// additionalProperties gets extra arguments through untouched.
func TestValidateInputAllowsExtrasWhenSchemaIsOpen(t *testing.T) {
	spec := Spec{Name: "t", Parameters: map[string]any{
		"type":       "object",
		"properties": map[string]any{"path": map[string]any{"type": "string"}},
	}}
	if err := ValidateInput(spec, decode(t, `{"path":"a","extra":1}`)); err != nil {
		t.Errorf("an open schema rejected an extra argument: %v", err)
	}
}

func TestValidateInputEnum(t *testing.T) {
	spec := Spec{Name: "t", Parameters: objSchema(map[string]any{
		"mode": map[string]any{"type": "string", "enum": []any{"read", "write"}},
	})}
	if err := ValidateInput(spec, decode(t, `{"mode":"read"}`)); err != nil {
		t.Errorf("a valid enum value was rejected: %v", err)
	}
	err := ValidateInput(spec, decode(t, `{"mode":"delete"}`))
	if err == nil {
		t.Fatal("a value outside the enum was accepted")
	}
	if !strings.Contains(err.Error(), "read") {
		t.Errorf("error %q does not list the valid options", err)
	}
}

// A schema this validator does not understand must make its tool permissive,
// never unusable — an external server can declare anything.
func TestValidateInputIgnoresUnknownSchemaFeatures(t *testing.T) {
	spec := Spec{Name: "t", Parameters: map[string]any{
		"type": "object",
		"properties": map[string]any{
			"weird": map[string]any{"oneOf": []any{map[string]any{"type": "string"}}},
			"any":   map[string]any{"type": "unheard-of"},
		},
	}}
	if err := ValidateInput(spec, decode(t, `{"weird":123,"any":{"a":1}}`)); err != nil {
		t.Errorf("an unfamiliar schema made the tool unusable: %v", err)
	}
	if err := ValidateInput(Spec{Name: "t"}, decode(t, `{"anything":1}`)); err != nil {
		t.Errorf("a tool with no schema rejected a call: %v", err)
	}
}

func TestValidateInputNestedObjects(t *testing.T) {
	spec := Spec{Name: "t", Parameters: objSchema(map[string]any{
		"opts": objSchema(map[string]any{"depth": map[string]any{"type": "integer"}}, "depth"),
	})}
	if err := ValidateInput(spec, decode(t, `{"opts":{"depth":2}}`)); err != nil {
		t.Errorf("a valid nested object was rejected: %v", err)
	}
	err := ValidateInput(spec, decode(t, `{"opts":{}}`))
	if err == nil {
		t.Fatal("a nested object missing a required field was accepted")
	}
	if !strings.Contains(err.Error(), "opts.depth") {
		t.Errorf("error %q should give the nested path", err)
	}
}

// Every native tool must declare which arguments it needs. Without this the
// model is told every argument is optional.
func TestNativeToolsDeclareRequiredArguments(t *testing.T) {
	r := NewRegistry()
	if err := NewNative(t.TempDir()).Register(r); err != nil {
		t.Fatal(err)
	}
	noArgs := map[string]bool{"process_list": true}
	for _, spec := range r.List() {
		if noArgs[spec.Name] {
			continue
		}
		if len(requiredNames(spec.Parameters)) == 0 {
			t.Errorf("native tool %q declares no required arguments", spec.Name)
		}
		// And an empty call must be rejected by the validator, not only
		// described as invalid in the schema.
		if err := ValidateInput(spec, map[string]any{}); err == nil {
			t.Errorf("native tool %q accepted a call with no arguments", spec.Name)
		}
	}
}

func TestErrorKindAndGuidance(t *testing.T) {
	e := &Error{Kind: ErrUnavailable, Tool: "mcp:blender:render", Message: "server gone"}
	if !strings.Contains(e.Error(), "mcp:blender:render") || !strings.Contains(e.Error(), "unavailable") {
		t.Errorf("Error() = %q, want the tool and the kind", e.Error())
	}
	if KindOf(e) != ErrUnavailable {
		t.Errorf("KindOf = %s, want unavailable", KindOf(e))
	}
	// A plain error is an ordinary failure, not an unknown one.
	if got := KindOf(errors.New("boom")); got != ErrFailed {
		t.Errorf("KindOf(plain) = %s, want %s", got, ErrFailed)
	}
	if KindOf(nil) != "" {
		t.Error("KindOf(nil) should be empty")
	}
	// A wrapped structured error must still be recognised.
	wrapped := errors.New("outer: " + e.Error())
	_ = wrapped
	if KindOf(&Error{Kind: ErrTimeout}) != ErrTimeout {
		t.Error("timeout kind lost")
	}
	// The guidance has to distinguish retryable from terminal, or it is not
	// worth sending to the model.
	if ErrInvalidInput.Guidance() == ErrUnavailable.Guidance() {
		t.Error("invalid_input and unavailable give the model the same advice")
	}
}
