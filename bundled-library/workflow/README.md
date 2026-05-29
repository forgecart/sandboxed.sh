# Bundled workflows

Each subdirectory here is one **dynamic workflow** — a JavaScript script
Claude Code's workflow runtime (2.1.154+) executes in a sandboxed VM.
When a mission starts, every workflow in this tree is written to
`.claude/workflows/<name>.js` in the mission's workspace. The CLI
parses the `meta` block, registers the script as a `/<name>` command,
and uses it the same way it uses the four bundled workflows
(`/autopilot`, `/bugfix`, `/dashboard`, `/deep-research`).

## Layout

```
workflow/
  <name>/
    <name>.js                 # the script — REQUIRED
    .workflow-source.json     # provenance metadata — REQUIRED
```

The directory name, the `.js` filename stem, and `meta.name` inside the
script must all match.

## Script shape

```js
export const meta = {
  name: '<name>',
  description: '...',
  whenToUse: '...',
  phases: [
    { title: 'Plan',      detail: '...' },
    { title: 'Implement', detail: '...' },
    // ...
  ],
};

phase('Plan');
const result = await agent({ prompt: '...' });

phase('Implement');
await parallel([
  agent({ prompt: '...' }),
  agent({ prompt: '...' }),
]);
```

### Hard constraints (enforced by the runtime parser)

- The first statement must be `export const meta = { ... }`.
- `meta` must be a pure literal — no template interpolation, no
  computed keys, no methods.
- Plain JavaScript only — no TypeScript syntax (type annotations,
  interfaces, generics all fail to parse).
- `meta` requires `name` (non-empty string) and `description`
  (non-empty string). `whenToUse`, `title`, and `phases[]` are
  optional but recommended.

### Runtime primitives available to scripts

| Primitive                       | What it does                                                                  |
| :------------------------------ | :---------------------------------------------------------------------------- |
| `agent({ prompt })`             | Spawn one subagent. Returns the agent's result.                               |
| `parallel([...])`               | Fan-out N agents concurrently; resolves to an array of results.               |
| `pipeline([...])`               | Run agents sequentially; each step receives the previous step's result.       |
| `phase('Name')`                 | Record a phase transition (visible in `/workflows` progress view + SSE).      |
| `log('msg')`                    | Emit a script-level log line (visible in `/workflows` progress view + SSE).   |
| `workflow('name', args)`        | Call another workflow. Nesting is limited to ONE level.                       |
| `args`                          | The string passed by the caller (e.g. `/forge "implement X"` → `args = "implement X"`). |

Up to 16 concurrent agents per run, 1,000 agents total per run. Runs
are resumable within the same Claude Code session.

## Validating a new workflow before committing

Parse with the same flags the runtime uses (acorn, `ecmaVersion: "latest"`,
`sourceType: "module"`, `allowAwaitOutsideFunction: true`,
`allowReturnOutsideFunction: true`):

```bash
cd /tmp
cat > check.mjs <<'EOF'
import { Parser } from "acorn";
import { readFileSync } from "fs";
const src = readFileSync(process.argv[2], "utf-8");
const ast = Parser.parse(src, {
  ecmaVersion: "latest",
  sourceType: "module",
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
});
console.log("OK — first statement:", ast.body[0].type);
EOF
npm install --silent acorn
node check.mjs /path/to/your/workflow.js
```

## Adding a new workflow

1. Pick a kebab-case `<name>` that matches the slash command you want.
2. `mkdir bundled-library/workflow/<name>` and write
   `<name>/<name>.js` + `<name>/.workflow-source.json`.
3. Add an `include_str!()` constant in `src/library/mod.rs` and seed it
   into the library in `seed_bundled_hackathon_items()` (mirror what
   `FORGE_WORKFLOW` does).
4. Add an entry to `BuiltinCommandsResponse` in
   `src/api/library.rs::build_builtin_commands()` so the composer's
   `/` autocomplete surfaces it.
5. `cargo check` + restart the backend. Spawn a fresh mission and
   confirm `.claude/workflows/<name>.js` is written and `/<name>`
   appears in autocomplete.

## Why workflows, not the old worker-mission pattern

Worker missions (the now-retired `orchestrator-mcp` MCP server) ran
subtasks in separate pods but had no verification step — the boss had
to trust the worker's summary. Workflows hold the orchestration in a
script (so the plan stays out of Claude's context window and survives
long runs) and bundle adversarial verification primitives:
`/autopilot` runs 5 critics in the plan phase and a 5-vote pigeonhole
verify + completeness check on the implementation. Our `/forge`
workflow follows the same pattern with forgecart-specific conventions
baked in.
