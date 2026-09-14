package event

// AllTypes is every event type the runtime can publish.
//
// It exists because a consumer that subscribes by name has no other way to
// learn the vocabulary, and guessing it is worse than it sounds. The browser
// front-end registers one listener per named SSE event; any type missing from
// its list arrives on the wire, matches no listener, and is never seen — but
// its Seq is still consumed. The next event the client does see then looks
// like a gap, and the gap detector reports events dropped when nothing was
// dropped at all. Handing out the list removes the guess.
//
// The order is the declaration order in event.go, and types_test.go fails if
// this slice and those constants ever disagree.
func AllTypes() []Type {
	return []Type{
		TaskCreated, TaskAnalyzed, TaskStarted, TaskPaused, TaskResumed,
		TaskCompleted, TaskFailed, TaskCancelled,
		StrategySelected,
		AgentCreated, AgentStarted, AgentPaused, AgentResumed, AgentUpdated,
		AgentCompleted, AgentFailed, AgentCancelled, AgentTranscript,
		ModelRequested, ModelResponded, ModelFailed,
		ToolRequested, ToolStarted, ToolCompleted, ToolFailed,
		ObservationCreated,
		ContextUpdated, ContextCondensed,
		EvaluationStarted, EvaluationComplete,
		RepairStarted, RepairCompleted,
		ApprovalRequested, ApprovalGranted, ApprovalDenied,
		BudgetExceeded,
		SessionStarted, SessionEnded,
		CheckpointSaved, ProviderLost, LogMessage,
	}
}
