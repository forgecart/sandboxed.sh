use serde_json::Value;

/// Backend-agnostic execution events.
#[derive(Debug, Clone)]
pub enum ExecutionEvent {
    /// Agent is thinking/reasoning.
    Thinking { content: String },
    /// Agent is calling a tool.
    ToolCall {
        id: String,
        name: String,
        args: Value,
    },
    /// Tool execution completed.
    ToolResult {
        id: String,
        name: String,
        result: Value,
    },
    /// Text content being streamed.
    TextDelta { content: String },
    /// Optional turn summary (backend-specific).
    TurnSummary { content: String },
    /// Token usage report from the backend (e.g. Codex turn.completed).
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    /// Goal-mode iteration marker. Emitted once per turn by the codex
    /// app-server driver when a goal is active so the UI can render
    /// "iter N" pills. `iteration` is 1-based and monotonically increasing
    /// within a single mission. Backends that don't run goal loops just
    /// don't emit this event.
    GoalIteration { iteration: u32, objective: String },
    /// Goal status transitioned (active/paused/budgetLimited/complete).
    /// Carries the canonical status string from codex's `thread/goal/updated`
    /// notification. UI renders this as a goal-state pill.
    GoalStatus { status: String, objective: String },
    /// Message execution completed.
    MessageComplete { session_id: String },
    /// Error occurred.
    Error { message: String },
    /// Inner event was emitted by a Claude Code sub-agent (the
    /// `Agent` tool's sidechain). The `parent_tool_use_id` is the
    /// tool_call_id of the spawning `Agent` invocation. Consumers
    /// route these to a per-sub-agent tab instead of the boss's
    /// chat. Plain wrap so we don't have to add a field to every
    /// other variant (which has ~25 construction sites across the
    /// codebase).
    Sidechain {
        parent_tool_use_id: String,
        inner: Box<ExecutionEvent>,
    },
}
