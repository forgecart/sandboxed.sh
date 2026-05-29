---
name: forge-orchestrator
description: >
  Forgecart orchestration entry point. For substantive coding tasks, invoke
  the /forge dynamic workflow — it plans with adversarial critics, implements,
  verifies, and opens a PR with our conventions. Do not orchestrate by hand.
---

# Forgecart Orchestrator

For any substantive coding task the user gives you, run **`/forge <task description>`**.

`/forge` runs deterministically inside Claude Code's workflow runtime: it scopes the task, hardens the plan against five critics (scope, simplicity, reuse, verification, correctness), implements the change, runs a five-finder bug-hunt with a five-vote pigeonhole verification and a completeness check, fixes anything confirmed, and opens a PR following our branch and commit conventions. The verification step is the difference between "shipped a diff" and "shipped a correct diff" — workers used to skip it; the workflow does not.

Use the bundled Claude Code workflows for narrower shapes:

- **`/bugfix <bug>`** — concrete reproducible bug: failing repro → root cause → minimal fix → regression test → PR.
- **`/dashboard <what to visualize>`** — discover data sources → design panels → implement → verify → PR.
- **`/deep-research <question>`** — fan-out web searches across angles, fetch sources, adversarially verify claims, synthesize a cited report.
- **`/autopilot <task>`** — Anthropic's generic equivalent of `/forge` (no forgecart-specific conventions).

Do not attempt to decompose tasks into hand-rolled subagent fan-outs yourself. The workflows hold the loop, the branching, and the intermediate results outside your context window — that's what makes them robust on long tasks. Your job is to pick the right workflow, pass the user's intent as `args`, and integrate the final result.

If the task genuinely doesn't fit a workflow (trivial one-liner, pure question, exploratory back-and-forth), handle it inline as usual — workflows are for substantive work that benefits from planning + verification.
