package tools

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// ValidateInput checks a tool call's arguments against the tool's declared
// JSON schema before the tool runs. Native tools mostly re-check their own
// arguments, but an external tool's arguments go straight to a foreign
// process: nothing here can assume the far side validates, or that it fails
// safely when it does not. Catching a bad call at the boundary also gives the
// model a message that names the tool and the field, instead of whatever the
// far side happens to say.
//
// This deliberately implements only the JSON Schema subset that tool schemas
// actually use — type, properties, required, enum, items and
// additionalProperties. Anything it does not understand it ignores rather than
// rejects, so an unusual schema from an external server makes its tool
// permissive, never unusable.
func ValidateInput(spec Spec, input map[string]any) error {
	if spec.Parameters == nil {
		return nil
	}
	if err := validateObject(spec.Parameters, input, ""); err != nil {
		return &Error{Kind: ErrInvalidInput, Tool: spec.Name, Message: err.Error()}
	}
	return nil
}

func validateObject(schema map[string]any, input map[string]any, path string) error {
	props, _ := schema["properties"].(map[string]any)

	for _, name := range requiredNames(schema) {
		if _, ok := input[name]; !ok {
			return fmt.Errorf("missing required argument %q", join(path, name))
		}
	}

	// additionalProperties:false is the schema saying the argument set is
	// closed. Reporting the unexpected name is what lets a model correct a
	// near-miss ("filename" for "path") rather than guess again.
	if allowed, ok := schema["additionalProperties"].(bool); ok && !allowed && props != nil {
		var unexpected []string
		for name := range input {
			if _, declared := props[name]; !declared {
				unexpected = append(unexpected, name)
			}
		}
		if len(unexpected) > 0 {
			sort.Strings(unexpected)
			return fmt.Errorf("unexpected argument(s) %s; allowed: %s",
				quoteList(unexpected), quoteList(propNames(props)))
		}
	}

	for name, raw := range input {
		sub, ok := props[name].(map[string]any)
		if !ok {
			continue // undeclared and tolerated, or a schema shape we do not read
		}
		if err := validateValue(sub, raw, join(path, name)); err != nil {
			return err
		}
	}
	return nil
}

func validateValue(schema map[string]any, value any, path string) error {
	// A null for a declared-but-optional field is the model saying "not
	// supplied"; treat it as absent rather than as a type error.
	if value == nil {
		return nil
	}
	want, _ := schema["type"].(string)
	if want != "" && !matchesType(want, value) {
		return fmt.Errorf("argument %q must be %s, got %s", path, want, describe(value))
	}
	if err := validateEnum(schema, value, path); err != nil {
		return err
	}
	switch want {
	case "object":
		if m, ok := value.(map[string]any); ok {
			return validateObject(schema, m, path)
		}
	case "array":
		items, ok := schema["items"].(map[string]any)
		if !ok {
			return nil
		}
		arr, ok := value.([]any)
		if !ok {
			return nil
		}
		for i, el := range arr {
			if err := validateValue(items, el, fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateEnum(schema map[string]any, value any, path string) error {
	raw, ok := schema["enum"].([]any)
	if !ok || len(raw) == 0 {
		return nil
	}
	got := fmt.Sprint(value)
	options := make([]string, len(raw))
	for i, opt := range raw {
		options[i] = fmt.Sprint(opt)
		if options[i] == got {
			return nil
		}
	}
	return fmt.Errorf("argument %q must be one of %s, got %q", path, quoteList(options), got)
}

// matchesType reports whether a decoded JSON value matches a schema type.
// DecodeArgs decodes with UseNumber, so every number arrives as json.Number
// and "integer" has to be checked against the text, not against a Go kind.
func matchesType(want string, value any) bool {
	switch want {
	case "string":
		_, ok := value.(string)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "number":
		return isNumber(value)
	case "integer":
		if !isNumber(value) {
			return false
		}
		return !strings.ContainsAny(fmt.Sprint(value), ".eE")
	}
	return true // unknown type keyword: not our business to reject
}

func isNumber(v any) bool {
	switch v.(type) {
	case json.Number, float64, float32, int, int64:
		return true
	}
	return false
}

func describe(v any) string {
	switch t := v.(type) {
	case string:
		return "a string"
	case bool:
		return "a boolean"
	case map[string]any:
		return "an object"
	case []any:
		return "an array"
	case json.Number:
		if strings.ContainsAny(t.String(), ".eE") {
			return "a number"
		}
		return "an integer"
	}
	if isNumber(v) {
		return "a number"
	}
	return fmt.Sprintf("%T", v)
}

func requiredNames(schema map[string]any) []string {
	raw, ok := schema["required"].([]any)
	if ok {
		out := make([]string, 0, len(raw))
		for _, r := range raw {
			if s, ok := r.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	// A schema built in Go rather than decoded from JSON carries the native
	// slice type.
	if out, ok := schema["required"].([]string); ok {
		return out
	}
	return nil
}

func propNames(props map[string]any) []string {
	out := make([]string, 0, len(props))
	for name := range props {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func quoteList(in []string) string {
	q := make([]string, len(in))
	for i, s := range in {
		q[i] = fmt.Sprintf("%q", s)
	}
	return strings.Join(q, ", ")
}

func join(path, name string) string {
	if path == "" {
		return name
	}
	return path + "." + name
}
