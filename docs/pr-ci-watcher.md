# PR-CI Watcher

When a mission's Bash invocation kicks off a GitHub Actions run, the
backend watches it on the agent's behalf and injects a
`<system-reminder>` into the mission's next turn with the verdict,
the check list, and (on failure) a tail of the failed-job log. The
agent never blocks on CI itself.

## Triggers

Five commands fire the watcher (detected from the Bash tool's
`command` field at ToolUse, finalized on ToolResult):

| Command pattern        | What gets watched                                          |
|------------------------|------------------------------------------------------------|
| `gh pr create [...]`   | The new PR's check rollup via `gh pr checks <num> --watch` |
| `gh pr merge [...]`    | Same — the merged PR's checks (post-merge CI rides too)    |
| `gh run rerun <id>`    | Run id via `gh run watch <id> --exit-status`               |
| `gh workflow run [...]`| The most recent run for the triggered workflow             |
| `git push [...]`       | Pushed-branch+commit → resolved to run id, then watched    |

Detection is leading-whitespace + word-boundary anchored (so
`echo "gh pr create"` doesn't false-fire). `git push --dry-run` is
explicitly skipped.

## How it works

```
on Bash ToolUse        ─▶ detect_ci_invocation(command) → CiKind
on matching ToolResult ─▶ parse_ci_target(kind, result_body) → CiTarget
                          spawn_watch_task(deps, mission_id, task)
                            │
                            ├─ if Commit target: resolve to Run via
                            │  `gh run list --branch --commit --limit 1`
                            │  (6 × 5 s retries — GH Actions takes time
                            │   to schedule the workflow after a push)
                            │
                            ├─ exec `gh pr checks <num> --watch` OR
                            │       `gh run watch <id> --exit-status`
                            │  inside the mission pod via WorkspaceExec.
                            │  Blocks until terminal or 2 h cap.
                            │
                            ├─ on failure: pull failed-job logs via
                            │  `gh run view <id> --log-failed | head -c 8K`
                            │
                            └─ compose <system-reminder>, inject via
                               ControlCommand::InjectSystemReminder.
                               watcher.remove(mission_id, tool_use_id).
```

No tick loop. No polling. One backend-owned `gh ... --watch`
subprocess per registered CI task — the same primitive the agent
would use, but backend-owned so the agent's turn doesn't block.

## Agent guidance + hard-block

Two layers prevent the agent from watching CI itself:

1. **CLAUDE.md addendum.** Per-mission `CLAUDE.md`
   (written by `K8sPodClient::write_mission_claude_md` in
   `src/k8s_pod.rs`) ends with a "Background CI watcher" section
   explaining the watcher and prohibiting `gh run watch`,
   `gh pr checks --watch`, and `gh actions watch`.

2. **Shell wrapper.** `docker/workspace-base/bashenv.sh` defines a
   `gh()` shell function that intercepts those three subcommands
   and exits with a stderr hint + non-zero return. The wrapper is
   `export -f`'d so it inherits into subshells. Human operators
   bypass with `command gh ...`.

If the agent somehow still slips through (e.g. dispatching `gh` via
a non-bash subprocess), no real damage — they just waste their own
turn while the backend's watch is still in flight.

## Auth

`gh` is installed in the workspace-base image
(`docker/workspace-base/Dockerfile:70`) and picks up auth from the
workspace's env_vars (`GH_TOKEN` or `GITHUB_TOKEN`). If neither is
set, the watch subprocess errors immediately; the watcher catches
the failure and injects a one-line reminder pointing at the missing
env var rather than looping.

## `<system-reminder>` bodies

Three shapes, all wrapped in `<system-reminder>…</system-reminder>`:

- **SUCCESS** — verdict line, run URL (when available), the
  `gh ... --watch` summary, "All checks passed."
- **FAILURE** — same shape plus the failed-job log tail (capped at
  8 KB).
- **TIMEOUT** — issued only when the 2 h cap fires. Tells the agent
  the run is still in flight or was cancelled while we waited.

## Configuration

| Env var                              | Default | Effect                                  |
|--------------------------------------|---------|-----------------------------------------|
| `SANDBOXED_SH_DISABLE_PR_CI_WATCHER` | unset   | Set `=1` to disable detection entirely. |
| `PR_CI_WATCHER_MAX_SECS`             | `7200`  | Hard cap on any single watch. 2 h.      |

## Cost

One persistent watch subprocess per pending CI task. CPU near-zero:
`gh ... --watch` polls every ~5 s internally and we just await its
exit. Token impact: zero — there's no LLM in the loop (unlike the
bg-watcher's sub-agent classifier).

## Limitations / out of scope

- Watcher restart loses in-flight watches. A backend pod restart
  kills all watch subprocesses; registrations live in memory only.
  Same trade-off the bg-watcher already makes.
- The watcher only **reports** — it never cancels, reruns, or
  comments on the PR.
- Non-K8sPod workspaces (nspawn / Host) are out of scope. The
  watcher rejects them with an error reminder.
- Cross-mission CI tracking.
- A "pending CI" pill in the dashboard alongside "pending bg"
  — could ride a follow-up if useful.

## Verification

End-to-end against `code.forgecart.com`:

1. `cargo clippy --workspace --all-targets` clean;
   `cd dashboard && bunx tsc --noEmit` clean.
2. CI rolls the new backend image AND the new workspace-base
   image (the shell wrapper ships in workspace-base).
3. Fresh mission: ask agent to open a draft PR. Backend logs show
   `pr-ci-watcher: spawned watch task kind=PrCreate`.
4. When CI completes, a `<system-reminder>` lands in the mission
   stream with the check list and verdict.
5. Ask the agent to `gh run watch <id>`. The shell wrapper prints
   the hint to stderr, exit code 2, and the agent treats it as
   "watcher will handle it."
6. The dashboard's agent-tasks panel is closed by default; the
   toggle button reopens it; reloading the page re-closes it.
7. Negative: trigger a known-failing CI. The watcher's reminder
   carries the failed-job log tail.
