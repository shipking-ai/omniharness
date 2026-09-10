package event

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// declaredTypes reads event.go and returns every constant declared with type
// Type. Parsing the source rather than listing the names again is the whole
// point: a second hand-written list would drift in exactly the way this test
// exists to catch.
func declaredTypes(t *testing.T) map[string]string {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "event.go", nil, 0)
	if err != nil {
		t.Fatalf("parse event.go: %v", err)
	}
	found := map[string]string{}
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			value, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			ident, ok := value.Type.(*ast.Ident)
			if !ok || ident.Name != "Type" {
				continue
			}
			for i, name := range value.Names {
				if i >= len(value.Values) {
					continue
				}
				lit, ok := value.Values[i].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				found[name.Name] = lit.Value
			}
		}
	}
	if len(found) == 0 {
		t.Fatal("found no Type constants in event.go; the parser is wrong, not the code")
	}
	return found
}

func TestAllTypesCoversEveryDeclaredType(t *testing.T) {
	declared := declaredTypes(t)

	listed := map[Type]bool{}
	for _, typ := range AllTypes() {
		if listed[typ] {
			t.Errorf("AllTypes lists %q twice; a duplicate makes a client subscribe twice and count every one of those events as two", typ)
		}
		listed[typ] = true
	}

	// The literal in the source includes its quotes; compare on the value.
	for name, quoted := range declared {
		value := Type(quoted[1 : len(quoted)-1])
		if !listed[value] {
			t.Errorf("event.%s (%q) is published by the runtime but missing from AllTypes; "+
				"a browser client would never subscribe to it, and would report its Seq as a dropped event", name, value)
		}
		delete(listed, value)
	}
	for extra := range listed {
		t.Errorf("AllTypes lists %q, which is not declared in event.go", extra)
	}
}
