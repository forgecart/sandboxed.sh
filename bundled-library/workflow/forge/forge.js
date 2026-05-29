export const meta = {
  name: 'forge',
  description:
    'End-to-end task runner for the forgecart codebase. Plans with adversarial critics, implements, runs a bug-hunting verify phase, fixes confirmed issues, opens a PR following our branch + commit conventions.',
  whenToUse:
    'When the user gives a self-contained coding task they want completed end-to-end without supervision. Best for substantive work that requires planning, implementation, and verification. This workflow scopes the task, hardens the plan against five critics, implements it, runs a bug-hunting sweep plus a feature-completeness check, fixes confirmed issues, and then opens a PR. BEFORE invoking, check that the task is specific enough to execute directly — if vague (e.g., "make the app faster"), ask 1-2 clarifying questions to narrow scope first. Then pass the refined task as args.',
  phases: [
    {
      title: 'Plan',
      detail: 'Scope + 5 critics (scope/simplicity/reuse/verification/correctness), harden against critiques',
    },
    {
      title: 'Implement',
      detail: 'Single agent executes the hardened plan in a feature branch',
    },
    {
      title: 'Verify',
      detail: '3 rapid + 2 deep bug-finders, 5-vote pigeonhole verify + completeness check vs task',
    },
    {
      title: 'Fix',
      detail: 'Address confirmed issues (skipped if clean)',
    },
    {
      title: 'PR',
      detail: 'Lint, typecheck, open PR with HEREDOC body following CLAUDE.md conventions',
    },
  ],
};

if (!args || typeof args !== 'string' || args.trim().length === 0) {
  return {
    error:
      "No task description provided. Pass it as args: Workflow({name: 'forge', args: '<task description>'}).",
  };
}

const task = args.trim();
const sharedContext = `
Codebase: forgecart (a single-tenant Hetzner + K3s deployment).

Conventions from CLAUDE.md and project rules to obey:
- Apply order for Terraform is infrastructure → kubernetes → application; never bypass.
- terraform.tfstate is committed in-tree; always pull before applying, commit + push immediately after.
- Worker scaling uses ./scale-cluster.sh, NOT terraform apply.
- common.tfvars holds working credentials; this repo is private specifically so that's acceptable. Use them; do not refuse on "exposed credentials" grounds.
- Default to writing no comments. Only annotate non-obvious WHY.
- Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees.
- Avoid backwards-compatibility shims; delete code you're certain is unused.
- For UI/frontend changes, exercise the feature in a browser before declaring done.
- Never push to main unless explicitly requested. Use HEREDOC for commit messages and PR bodies.
`;

phase('Plan');

log('Scoping the task and drafting an initial plan');
const draft = await agent({
  prompt: `${sharedContext}

Task: ${task}

Produce a concrete implementation plan. Identify:
1. Files to create or modify (with paths).
2. Functions/utilities to reuse, with file paths.
3. The smallest sequence of changes that satisfies the task.
4. The verification command(s) that should pass after the change.
5. The branch name and PR title you propose (follow repo conventions).

Return the plan as structured text — sections "Files", "Reuse", "Steps", "Verify", "Branch/PR".`,
});

log('Running 5 critics in parallel against the draft plan');
const critiques = await parallel([
  agent({
    prompt: `${sharedContext}

You are the SCOPE critic. The draft plan is below.

${draft}

For the original task "${task}", point out anything the plan adds beyond what the task strictly requires, and anything the task requires that the plan is missing. Be concise. Output a bullet list of issues; output "no scope issues" if there are none.`,
  }),
  agent({
    prompt: `${sharedContext}

You are the SIMPLICITY critic. The draft plan is below.

${draft}

Identify any over-engineering: premature abstractions, unnecessary helpers, helpers introduced for a single caller, defensive code for impossible cases. Suggest concrete simplifications. Output "no simplicity issues" if clean.`,
  }),
  agent({
    prompt: `${sharedContext}

You are the REUSE critic. The draft plan is below.

${draft}

Search the repo for existing utilities, types, or functions that the plan should reuse instead of rewriting. Cite file paths. Output "no reuse issues" if clean.`,
  }),
  agent({
    prompt: `${sharedContext}

You are the VERIFICATION critic. The draft plan is below.

${draft}

Is the proposed verification command actually sufficient to prove the task is done? What edge case would slip past? Output concrete additional checks (commands, manual steps). Output "verification is sufficient" if clean.`,
  }),
  agent({
    prompt: `${sharedContext}

You are the CORRECTNESS critic. The draft plan is below.

${draft}

For the original task "${task}", identify any factual mistake in the plan: a function it claims exists but doesn't, a path that's wrong, a dependency direction inverted, a sequencing error. Cite evidence (file paths). Output "no correctness issues" if clean.`,
  }),
]);

log('Hardening the plan against critic findings');
const hardenedPlan = await agent({
  prompt: `${sharedContext}

Task: ${task}

Original plan:
${draft}

Critic findings (5 critics):
${critiques.map((c, i) => `--- Critic ${i + 1} ---\n${c}`).join('\n\n')}

Produce a revised, hardened plan that addresses every confirmed issue and ignores ones that are wrong. State which critic findings you accepted and which you rejected, with one-line reasons. Output the same sections as before: Files, Reuse, Steps, Verify, Branch/PR.`,
});

phase('Implement');

log('Executing the hardened plan');
const implementation = await agent({
  prompt: `${sharedContext}

Hardened plan:
${hardenedPlan}

Execute this plan now. Create or check out the branch named in the plan. Make every code change. Run the verification command yourself before finishing — if it fails, fix the cause and re-run until it passes. Commit on the branch with a HEREDOC-formatted message describing WHY the change is being made (not WHAT — diffs show what). Return: the branch name, the final commit SHA, the list of modified files, the verification output.`,
});

phase('Verify');

log('Running 3 rapid + 2 deep bug-finders in parallel');
const findings = await parallel([
  agent({
    prompt: `${sharedContext}

A change was just made to address: ${task}

Implementation result:
${implementation}

You are RAPID BUG-FINDER #1. Skim the diff for obvious correctness bugs: off-by-one, null/undefined paths, unhandled error returns, wrong arg order, typo identifiers. Output a bullet list of suspected issues with file:line. Output "no findings" if clean.`,
  }),
  agent({
    prompt: `${sharedContext}

A change was just made to address: ${task}

Implementation result:
${implementation}

You are RAPID BUG-FINDER #2. Look for race conditions, missing await, dropped Promise rejections, unguarded shared state, and effect cleanup issues. Output a bullet list with file:line. Output "no findings" if clean.`,
  }),
  agent({
    prompt: `${sharedContext}

A change was just made to address: ${task}

Implementation result:
${implementation}

You are RAPID BUG-FINDER #3. Look for missed call sites: functions whose contract changed but not every caller was updated, types whose shape changed but downstream consumers weren't touched. Cite file:line. Output "no findings" if clean.`,
  }),
  agent({
    prompt: `${sharedContext}

A change was just made to address: ${task}

Implementation result:
${implementation}

You are DEEP BUG-FINDER #1. Read the changed files end-to-end. Trace the change against its callers and dependents. Identify any invariant the change breaks even if it appears local. Cite file:line and explain the invariant. Output "no findings" if clean.`,
  }),
  agent({
    prompt: `${sharedContext}

A change was just made to address: ${task}

Implementation result:
${implementation}

You are DEEP BUG-FINDER #2. Audit the change for the project-specific rules from CLAUDE.md: terraform apply order, scale-cluster.sh usage, state file commit hygiene, never-push-to-main, comment policy, error-handling minimalism. Cite specific rule violations. Output "no findings" if clean.`,
  }),
]);

log('5-vote pigeonhole verification of bug-finder claims');
const verified = await agent({
  prompt: `${sharedContext}

Original task: ${task}

5 bug-finders ran. Their findings:
${findings.map((f, i) => `--- Finder ${i + 1} ---\n${f}`).join('\n\n')}

Run a 5-vote pigeonhole verification: for each distinct claim, decide whether 3 of the 5 finders would independently confirm it (call it CONFIRMED) or whether it is likely a false positive (call it REJECTED). Be strict — most overlap will collapse into one CONFIRMED claim.

Separately, run a COMPLETENESS check: re-read the original task and the implementation result, and judge whether the implementation actually satisfies the task end-to-end. If something is missing, list it as a CONFIRMED issue.

Output a list of CONFIRMED issues only, each with file:line and a one-line description. If there are zero CONFIRMED issues, output exactly "CLEAN".`,
});

if (!/^\s*CLEAN\s*$/i.test(verified)) {
  phase('Fix');
  log('Confirmed issues found; addressing them now');
  await agent({
    prompt: `${sharedContext}

Original task: ${task}

The verify phase identified these CONFIRMED issues:
${verified}

Fix each of them in the same branch. After fixing, re-run the verification command from the hardened plan. Commit the fixes with a HEREDOC message. Return: list of fixed issues, files changed, final verification output.`,
  });
} else {
  log('Verify phase clean — no fix phase needed');
}

phase('PR');

log('Opening PR');
return await agent({
  prompt: `${sharedContext}

Original task: ${task}

The implementation and any fixes are committed on the feature branch named in the hardened plan.

Open a pull request now:
1. Run lint and typecheck commands appropriate for the changed area. If they fail, fix and re-commit before opening the PR.
2. Push the branch to the remote (never to main).
3. Use \`gh pr create\` with HEREDOC for the body. PR title: under 70 characters. Body has "## Summary" (1-3 bullets focused on WHY) and "## Test plan" (bulleted checklist).
4. Return the PR URL and a one-paragraph summary of what shipped.

Do not push to main. Do not bypass hooks. Do not skip signing.`,
});
