# Background bash watcher

Drives the completion callback that Claude Code's `--print` headless
mode can't deliver, so the main agent learns when its `Bash(run_in_background:true)`
tasks finish — or hang — instead of panic-retrying them.

## Why this exists

Claude Code's `Bash(run_in_background: true)` tool returns:

```
Command running in background with ID: <id>. Output is being written
to: …/tasks/<id>.output. You will be notified when it completes.
```

In the interactive TUI, the runtime fires that notification at the
start of the next assistant turn. Our `claudecode` backend runs the
CLI in `--print` (`-p`) headless mode — one assistant turn per user
message — so the runtime has no slot to inject the callback mid-stream.
The contract is structurally undeliverable in our setup.

Evidence from a real conversation
(`cfe077f0-3541-42f9-860d-3e88c6c5448f`, May 27): 27 backgrounds across
the mission, **0** follow-up `BashOutput` or `KillShell` calls, and a
panic-retry loop where the agent fired the same `pnpm install` five
times in 32 seconds because it never received the documented "you will
be notified" callback. Five concurrent installs contended for the same
pnpm lockfile and the conversation visibly stalled.

## How it works

```
mission pod
  └─ bg-watchd (long-running daemon)
        inotify-watches Claude Code's tasks dir, writes sidecars:
          <id>.ts        — per-modify log "<file_size>\t<ISO8601>\n"
          <id>.pid       — PID of the writer (via lsof on IN_CREATE)
          <id>.complete  — touched on IN_CLOSE_WRITE

backend
  ├─ SharedBackgroundWatcher
  │     in-memory HashMap<MissionId, Vec<BgTask>>
  │     populated by the claudecode stream interceptor in
  │     mission_runner::run_mission_turn (parses the
  │     "Command running in background with ID: <id>" tool_result)
  │
  └─ tick loop (every 10 min by default):
        for each pending task in each mission:
          1. workspace_exec a single heredoc that cat's
             <id>.output (head + tail), reads the .ts / .pid /
             .complete sidecars, and ps the PID.
          2. Build a one-message classifier prompt.
          3. Spawn `claude --print -p '<prompt>' --model <main mission's model>`
             inside the pod (auth inherits from env).
          4. Parse first token: DONE / STUCK / PROGRESSING.
          5. DONE → inject `<system-reminder>` with the truncated
                    output via ControlCommand::InjectSystemReminder,
                    drop the watcher entry.
             STUCK → inject `<system-reminder>` stall report (main
                     agent decides whether to KillShell — watcher
                     never kills).
             PROGRESSING → no-op; next tick in 10 min.
```

The injection routes through the existing `MissionRunner` FIFO queue
— the same path the resume-prompt injection uses today — so the
agent processes the reminder between turns just like a user message.

## Output cap

The classifier prompt and the `DONE` payload both cap output at
8 KB head + 8 KB tail with an omitted-bytes marker in the middle.
That's enough for compile/install logs where you only care about
errors or the final summary; one 200 KB `pnpm install` log would
otherwise eat half the context window. The `STUCK` payload uses a
tighter 4 KB tail (only the tail matters when classifying a stall).

## Disable / tune

| Env                                    | Effect                                              |
| :------------------------------------- | :-------------------------------------------------- |
| `SANDBOXED_SH_DISABLE_BG_WATCHER=1`    | Watcher tick loop never spawns. Registrations still happen but go unused. Falls back to current "fire and forget" behaviour. |
| `BG_WATCHER_INTERVAL_SECS=600`         | Tick cadence in seconds. Default 600 (10 min).      |
| `SANDBOXED_SH_DISABLE_BG_WATCHD=1`     | Pod-side daemon never starts. Sidecar files won't be written; the tick loop will degrade gracefully (no `<id>.ts` / `.pid` / `.complete`). |
| `BG_WATCHD_ROOTS=/tmp/claude-0:/root/.claude` | Colon-separated list of dirs the pod-side daemon recursively inotifies. Defaults to `/tmp/claude-0` plus `$HOME/.claude`. |
| `BG_WATCHD_LOG=info,bg_watchd=debug`   | tracing-subscriber filter for the pod-side daemon. |

## Cost

Each pending task triggers one `claude --print -p` subprocess per
tick (10 min). On a typical mission with 1-2 backgrounds the cost is
a few cents an hour; on a busy mission with 6+ concurrent backgrounds
on Opus 4.8 it's ~$0.30/hr while tasks are pending. Tasks drop off
the watcher map on `DONE`, so the cost decays naturally as tasks
finish.

## Limitations / known gaps

- **10-min first signal.** A 30-second `pnpm test` waits up to 10 min
  before the main agent learns it finished. Operator accepted this
  trade-off (uniform policy, simpler watcher, fewer race conditions).
  Mitigation if it hurts: bolt on an inotify `IN_CLOSE_WRITE` fast
  path that bypasses the sub-agent and injects DONE the moment the
  output file closes.
- **In-memory state.** Watcher state is lost on backend restart. The
  existing `stuck_mission_watchdog_loop` has the same property; the
  sidecar files survive, so a new tick loop can re-discover the work
  the next time the same task gets registered.
- **No `<id>.exit-code`.** We can't recover the actual exit code
  without wrapping the agent's command. The classifier doesn't need
  it — DONE/STUCK is enough — but it surfaces as "(unknown exit)"
  in the system-reminder.
- **Single-process `bg-watchd`.** If it panics, sidecar files stop
  updating and the next tick may misclassify a healthy task as STUCK
  (no fresh `.ts` entries). Mitigation: `entrypoint.sh` runs it as a
  background child of PID 1 and the trap cleans it up; we can add a
  restart-on-exit loop later if it proves flaky.
