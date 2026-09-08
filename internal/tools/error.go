package tools

import (
	"errors"
	"fmt"
)

// ErrorKind classifies a tool failure. It exists so callers can branch on what
// went wrong without matching on message text — the same reason gateway.Error
// carries a Kind. Substring matching on error strings is how a message reword
// silently changes behavior.
type ErrorKind string

const (
	// ErrInvalidInput: the call did not match the tool's declared schema. The
	// model can fix this itself by calling again with corrected arguments.
	ErrInvalidInput ErrorKind = "invalid_input"
	// ErrUnavailable: the tool exists but cannot run — its provider is gone,
	// or a required program is missing. Calling again will not help.
	ErrUnavailable ErrorKind = "unavailable"
	// ErrTimeout: the tool ran but did not finish in time.
	ErrTimeout ErrorKind = "timeout"
	// ErrFailed: the tool ran and reported a failure. This is the ordinary
	// case — a command exited non-zero, a file was missing — and it is the
	// default for an error that arrives without a kind.
	ErrFailed ErrorKind = "failed"
)

// Error is a structured tool failure.
type Error struct {
	Kind    ErrorKind
	Tool    string
	Message string
}

func (e *Error) Error() string {
	if e.Tool == "" {
		return fmt.Sprintf("%s: %s", e.Kind, e.Message)
	}
	return fmt.Sprintf("tool %s: %s: %s", e.Tool, e.Kind, e.Message)
}

// Guidance is what the agent tells the model after a failed call. It says what
// to do next, because the kind is the only thing that reliably distinguishes
// "fix your arguments and call again" from "this is gone, stop trying" — and a
// model that cannot tell those apart burns iterations retrying the impossible.
func (k ErrorKind) Guidance() string {
	switch k {
	case ErrInvalidInput:
		return "Correct the arguments and call the tool again."
	case ErrUnavailable:
		return "This tool cannot run. Do not call it again; use a different approach."
	case ErrTimeout:
		return "The tool did not finish in time. Try a smaller or more specific request."
	default:
		return "Read the error, then decide whether to adjust the call or take another approach."
	}
}

// KindOf reports the kind of an error, defaulting to ErrFailed for any error
// that is not a *Error. Nothing has to construct a *Error for the common case.
func KindOf(err error) ErrorKind {
	if err == nil {
		return ""
	}
	var te *Error
	if errors.As(err, &te) {
		return te.Kind
	}
	return ErrFailed
}
