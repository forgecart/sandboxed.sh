# Repo CI listener

## Why

Same structural gap that motivated `background_watcher`: Claude Code's
`--print` invocation never gets to deliver a delayed callback to the
agent. When a mission triggers GitHub Actions — via `gh pr create`,
`gh pr merge`, `gh workflow run`, `gh run rerun`, or just a plain
`git push` — the bash returns in seconds, but CI keeps churning for
minutes. Without intervention the agent either misses failures or
blocks the foreground turn on `gh run watch`, wasting context.

## Architecture

```
backend startup ──► repo_ci_listener::spawn(deps)
                        │
                        └─► tokio task (poll loop, default every 30 s)
                                │
                                ▼
                        for every Active K8sPod mission:
                          1. ls /workspaces/repos/*/
                          2. git remote get-url origin → owner/repo
                          3. gh run list -R owner/repo --json …
                          4. for each new completion (databaseId > cursor):
                             a. broadcast AgentEvent::MissionPrCiUpdate
                             b. InjectSystemReminder via ControlCommand
                             c. broadcast another MissionPrCiUpdate
                                with status="removed" so the panel
                                drops the row
```

One poll loop, one process. No per-watch spawn, no bash-stream
parsing, no `--watch` subprocesses. The agent's shell never has to
block.

### Cursor handling

The first time the listener polls a given `(mission_id, owner,
repo)` tuple, it sets the cursor to the latest existing
`databaseId` returned by `gh run list` **without** emitting any
reminders. This prevents a flood when a long-lived repo is freshly
cloned (or after a backend restart). Subsequent polls only emit
for completions with `databaseId` strictly greater than the cursor.

Cursors are in-memory. A backend restart re-initialises them on the
first poll after start — losing at most the (rare) history within
the restart window.

### Skipped repos

- A directory under `/workspaces/repos/` without a `.git`
  subdirectory.
- A repo whose `origin` URL doesn't parse as `github.com/owner/repo`
  (e.g. GitLab, Bitbucket, a fork hosted elsewhere).
- A repo where `gh run list` exits non-zero — typically missing
  `GH_TOKEN`. The listener debug-logs and tries again next cycle.

## SSE / UI

`AgentEvent::MissionPrCiUpdate { mission_id, tool_use_id, target,
status, checks, url }` is the only event the dashboard sees. The
field names are inherited from the previous bash-intercept design,
so the dashboard's `PrCiWatchPanel` keeps working unmodified. The
listener uses `tool_use_id` as `"<owner>/<repo>#<run_id>"` (the
stable per-completion key) and `target` as `"run <id> in
owner/repo (branch)"`.

Two events fire per detection: one with `status="completed"` (the
panel flashes the verdict), then `status="removed"` immediately
after the `<system-reminder>` lands.

## Reminder shape

```
<system-reminder>
GitHub Actions run PASSED|FAILED: <workflow> on <owner>/<repo> (<branch>)
Title: <displayTitle>
Commit: <head_sha[..8]>
Event: <event>
URL: <run url>

Jobs:
  • <job-name> — <conclusion-or-status>
  …

Failed-job log tail (truncated):    # only on failure
```
…last ≤ 8 KiB of `gh run view <id> --log-failed`…
```

This reminder was emitted by the repo-ci-listener.
</system-reminder>
```

The job rollup comes from `gh run view <id> --json jobs`. The log
tail is best-effort: if `gh run view --log-failed` fails or returns
nothing, the section is omitted.

## Config knobs

| Env var | Default | Effect |
|---------|---------|--------|
| `REPO_CI_LISTENER_INTERVAL_SECS` | `30` | Seconds between poll cycles |

## Failure modes

| Symptom | Likely cause | Mitigation |
|---------|--------------|------------|
| No reminders ever fire for a repo you push to | `gh` auth missing in pod (`GH_TOKEN` unset) | Forward the token via the workspace's env_vars secret; the listener will succeed on the next cycle |
| Reminder mentions wrong owner/repo | Repo's `origin` remote was changed after first poll | The cursor key is `(mission, owner, repo)`; rename will create a new key and the new repo will seed quietly |
| One repo's reminders are duplicated | (Shouldn't happen) Two polls overlapped — the loop is serial, so this would indicate a bug | Check tracing logs; `cursors` should monotonically advance |
| Reminder is stale (CI completed a long time ago) | First poll after backend restart treated the run as historical — no reminder | Working as intended; the listener prefers silence over historical flood |
| Job log tail not shown on failure | `gh run view --log-failed` exited non-zero (e.g. logs already expired) | Inspect the run via the URL in the reminder |

## Tracing

```
RUST_LOG=sandboxed_sh::api::repo_ci_listener=info  # default
RUST_LOG=sandboxed_sh::api::repo_ci_listener=debug # per-mission detail
```

Key spans:
- `repo_ci_listener: spawned interval_secs=30` — startup
- `repo_ci_listener: initialised cursor` — first-poll seed
- `repo_ci_listener: poll cycle failed` — list_missions failure (rare)

## Tests

Unit tests for the parsing helpers (`parse_github_origin`,
`parse_run_list`) live in `src/api/repo_ci_listener.rs` `#[cfg(test)]`.
End-to-end verification uses the
`.github/workflows/ci-watcher-test.yml` workflow (10-15 s smoke
job triggered by pushes to the `ci-watcher-test` branch).

## Historical: pr_ci_watcher

The previous implementation intercepted bash tool calls in
`mission_runner` to detect CI-triggering commands and spawned one
`gh ... --watch` subprocess per registration. That design had to
deal with chained shell commands, `[new branch]` push parsing,
`gh repo view` cwd dependencies, and an agent-side `gh()` shell
wrapper to prevent double-watches. The repo-listener design throws
all of that away: the backend is the single source of truth, polling
is straightforward, and the agent's shell is untouched.

Removed: `src/api/pr_ci_watcher.rs`, the `gh()` wrapper in
`docker/workspace-base/bashenv.sh`, the bash-stream interception in
`src/api/mission_runner.rs`.
