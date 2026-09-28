// Package instructions reads the repository's own agent instruction file.
//
// AGENTS.md is the cross-vendor convention for telling an agent how to work in
// a particular repository — build commands, test commands, conventions, the
// things a README says to a person and does not say to a tool. It is plain
// Markdown with no schema, which is most of why it spread.
//
// The harness used to have a ProjectInstructions channel fed only from its own
// memory: notes an earlier task chose to remember. That is worth keeping, but
// it means a fresh clone of a repository that documents exactly how to build
// itself told the agent nothing, and the agent rediscovered it by trial. The
// file is right there.
package instructions

import (
	"os"
	"path/filepath"
	"strings"
)

// Files are the instruction filenames, in the order they win.
//
// AGENTS.md is the canonical cross-vendor name and comes first. The others are
// read only when it is absent, because a repository that carries several is
// mirroring one source and reading all of them would put the same guidance in
// the prompt two or three times.
var Files = []string{"AGENTS.md", "CLAUDE.md", "GEMINI.md"}

// MaxBytes bounds what one file may contribute.
//
// The composer's token budget would clip an oversized file anyway, but it
// would do it by trimming the *system prompt as a whole* — so a 400KB
// AGENTS.md would push out the task profile and the acceptance criteria to
// make room for itself. Bounding it here means an over-long instruction file
// costs only its own tail.
const MaxBytes = 16 << 10

// Doc is one instruction file that was found and read.
type Doc struct {
	// Name is the bare filename, e.g. "AGENTS.md".
	Name string
	// Content is the file's text, with a truncation marker appended when the
	// file was longer than MaxBytes.
	Content string
	// Truncated reports whether content was cut.
	Truncated bool
}

// Read returns the instruction file for a workspace, or nil when there is
// none.
//
// Every failure resolves to nil. An unreadable or missing file is the normal
// case — most repositories have no AGENTS.md — and it is never a reason to
// fail a task.
func Read(workspace string) *Doc {
	if workspace == "" {
		return nil
	}
	for _, name := range Files {
		b, err := os.ReadFile(filepath.Join(workspace, name))
		if err != nil {
			continue
		}
		text := strings.TrimSpace(string(b))
		if text == "" {
			// An empty file is not guidance. Keep looking: a repository with
			// a placeholder AGENTS.md may still have a real CLAUDE.md.
			continue
		}
		doc := &Doc{Name: name, Content: text}
		if len(doc.Content) > MaxBytes {
			doc.Content = strings.TrimSpace(doc.Content[:MaxBytes]) +
				"\n\n[truncated — this file is longer than the harness reads]"
			doc.Truncated = true
		}
		return doc
	}
	return nil
}

// Lines renders a Doc for composer.Input.ProjectInstructions.
//
// The instructions channel is a list of one-line notes, and an AGENTS.md is a
// Markdown document, so the whole document goes in as a single labelled entry
// rather than being split into lines. Splitting it would strip the structure
// the file uses to be readable — headings, code fences, lists — and leave the
// model reading shredded prose.
//
// The label names the file so the model can tell repository guidance from a
// note the harness remembered; they carry different authority, and a reader
// that cannot tell them apart cannot weigh them.
func (d *Doc) Lines() []string {
	if d == nil {
		return nil
	}
	return []string{"From " + d.Name + " in this repository:\n" + d.Content}
}
