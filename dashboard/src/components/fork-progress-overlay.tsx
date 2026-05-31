"use client";

// ForkProgressOverlay — the blocking checklist that replaces the
// existing PodStartupBanner while a K8sPod mission's pod_phase is
// anything other than "ready" or null.
//
// The backend's `mission_fork::run_fork` emits granular phase
// updates (see src/api/mission_fork.rs) and stuffs a JSON payload
// into `pod_message`. We JSON-parse opportunistically — non-fork
// missions (and the existing nspawn/Host workspaces) still write a
// plain string into pod_message and we fall back to rendering it
// verbatim.
//
// Per-row state derivation:
//   - rows whose phase index < current → done (✓)
//   - row whose phase matches current  → active (spinner)
//   - rows whose phase index > current → pending (○)
//   - on error, the row that was active at error time turns red and
//     `pod_message.error` is shown beneath it.

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, Circle, Loader, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// Fork missions walk this taxonomy. The first four phases are
// fork-only (`mission_fork::run_fork`); the last three are shared
// with fresh missions (see `FRESH_ORDER` below).
const FORK_ORDER = [
  "events_copying",
  "quiescing_source",
  "snapshotting",
  "pvc_provisioning",
  "pod_starting",
  "dockerd_starting",
  "compose_starting",
  "ready",
] as const;

// Fresh-mission bootstrap walks this taxonomy (PodStartupEvent values
// from `src/k8s_pod.rs` + the post-Ready dockerd/compose probes added
// in `spawn_mission_pod_bootstrap`).
const FRESH_ORDER = [
  "pvc_binding",
  "pod_scheduled",
  "pulling",
  "pulled",
  "container_starting",
  "container_ready",
  "init_script_running",
  "dockerd_starting",
  "compose_starting",
  "ready",
] as const;

type PhaseId = (typeof FORK_ORDER)[number] | (typeof FRESH_ORDER)[number];

const PHASE_LABELS: Record<PhaseId, string> = {
  // fork-only
  events_copying: "Copy conversation history",
  quiescing_source: "Pause source docker (capture-point quiesce)",
  snapshotting: "Snapshot source disks",
  pvc_provisioning: "Claim forked volumes",
  pod_starting: "Start forked pod",
  // fresh-only (PodStartupEvent values)
  pvc_binding: "Bind storage",
  pod_scheduled: "Schedule pod",
  pulling: "Pull workspace image",
  pulled: "Image pulled",
  container_starting: "Start container",
  container_ready: "Container ready",
  init_script_running: "Run workspace init script",
  // shared
  dockerd_starting: "Start Docker daemon",
  compose_starting: "Start docker-compose services",
  ready: "Ready",
};

/// Pick the right phase order based on which set the current phase
/// belongs to. Unknown phases default to the fresh-mission order so
/// the overlay still renders sensibly during a partial rollout.
function orderFor(phase: string | null | undefined): readonly PhaseId[] {
  if (!phase) return FRESH_ORDER;
  if ((FORK_ORDER as readonly string[]).includes(phase)) return FORK_ORDER;
  return FRESH_ORDER;
}

type RowState = "done" | "active" | "pending" | "error";

interface SnapItem {
  name: string;
  status: string; // pending | in_progress | done
}

interface ComposeService {
  service?: string;
  state?: string;
  health?: string;
  status?: string;
  image?: string;
}

interface ParsedDetail {
  label?: string;
  error?: string;
  events_copied?: number;
  events?: number;
  items?: SnapItem[];
  services?: ComposeService[];
  sub?: string;
}

function parseDetail(message: string | null | undefined): ParsedDetail | null {
  if (!message) return null;
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object") {
      return parsed as ParsedDetail;
    }
  } catch {
    // Plain-string pod_message (legacy / non-fork). Render it raw.
    return { label: message };
  }
  return null;
}

function rowState(
  rowPhase: PhaseId,
  currentPhase: string | undefined,
  order: readonly PhaseId[],
): RowState {
  if (!currentPhase) return "pending";
  if (currentPhase === "error") {
    // The row that was active when the error fired isn't tracked
    // separately by the backend — we display the error label on a
    // generic "Fork failed" row rendered by the parent below.
    return "pending";
  }
  if (currentPhase === "ready") {
    // Everything done. The "ready" row itself is "done"; all
    // earlier rows are "done" too.
    return "done";
  }
  const rowIdx = order.indexOf(rowPhase);
  const curIdx = order.indexOf(currentPhase as PhaseId);
  if (curIdx === -1) {
    // Backend emitted a phase we don't recognise. Show all rows as
    // pending and let the caller display the raw label.
    return "pending";
  }
  if (rowIdx < curIdx) return "done";
  if (rowIdx === curIdx) return "active";
  return "pending";
}

function StateIcon({ state }: { state: RowState }) {
  if (state === "done")
    return <CheckCircle className="h-4 w-4 shrink-0 text-emerald-400" />;
  if (state === "active")
    return (
      <Loader className="h-4 w-4 shrink-0 animate-spin text-indigo-400" />
    );
  if (state === "error")
    return <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />;
  return <Circle className="h-4 w-4 shrink-0 text-white/20" />;
}

function SnapshotItemList({ items }: { items: SnapItem[] }) {
  return (
    <ul className="mt-1 space-y-0.5 pl-6 text-[11px] text-white/50">
      {items.map((it) => (
        <li key={it.name} className="flex items-center gap-1.5">
          {it.status === "done" ? (
            <CheckCircle className="h-3 w-3 text-emerald-400" />
          ) : it.status === "in_progress" ? (
            <Loader className="h-3 w-3 animate-spin text-indigo-400" />
          ) : (
            <Circle className="h-3 w-3 text-white/20" />
          )}
          <span>{it.name}</span>
        </li>
      ))}
    </ul>
  );
}

function ComposeServiceList({ services }: { services: ComposeService[] }) {
  if (!services || services.length === 0) {
    return (
      <p className="mt-1 pl-6 text-[11px] italic text-white/40">
        Waiting for `docker compose up` to start services…
      </p>
    );
  }
  return (
    <ul className="mt-1 space-y-0.5 pl-6 text-[11px]">
      {services.map((svc) => {
        const name = svc.service ?? "(unknown)";
        const state = svc.state ?? "";
        const health = svc.health ?? "";
        // Ready: running+healthy (or running with no healthcheck),
        // or a clean exit-0 init container.
        const ready =
          (state === "running" && ["healthy", "", "none"].includes(health)) ||
          (state === "exited" && (svc.status ?? "").includes("Exited (0)"));
        const failed =
          state === "exited" && !(svc.status ?? "").includes("Exited (0)");
        return (
          <li key={name} className="flex items-center gap-1.5">
            {ready ? (
              <CheckCircle className="h-3 w-3 text-emerald-400" />
            ) : failed ? (
              <AlertTriangle className="h-3 w-3 text-rose-400" />
            ) : (
              <Loader className="h-3 w-3 animate-spin text-indigo-400" />
            )}
            <span className="text-white/70">{name}</span>
            <span className="text-white/40">
              {state}
              {health && health !== "none" ? ` · ${health}` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export interface ForkProgressOverlayProps {
  /** Current `mission.pod_phase` */
  phase: string | null | undefined;
  /** Current `mission.pod_message` (may be a JSON blob or a plain string) */
  message: string | null | undefined;
  /** Mission title for the header */
  title: string | null | undefined;
  /** Per-repo `docker compose up` stdout tail, streamed by the
   *  backend's `run_compose_up_with_logs`. Rendered beneath the
   *  compose_starting row, one collapsible block per repo. */
  composeLogs?: Record<string, string[]> | null;
}

function LogTail({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  // Render the last 30 lines — older lines stay in the ring buffer
  // but the visible tail is bounded so a long pull doesn't blow the
  // overlay layout.
  const visible = lines.slice(-30);
  return (
    <pre
      ref={ref}
      className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words bg-black/40 px-2 py-1.5 font-mono text-[10px] leading-snug text-white/60"
    >
      {visible.length === 0 ? (
        <span className="italic text-white/30">
          (waiting for `docker compose up -d` output…)
        </span>
      ) : (
        visible.join("\n")
      )}
    </pre>
  );
}

// Console-style log panel: small tab strip (one per repo) above a
// shared scrolling pane. Active tab auto-switches to whichever repo
// gained the most lines this render — unless the operator clicked
// a specific tab, in which case the auto-switch is suspended until
// the overlay closes (next ready phase).
function ComposeLogConsole({ logs }: { logs: Record<string, string[]> }) {
  const repos = useMemo(() => Object.keys(logs).sort(), [logs]);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [manualPick, setManualPick] = useState(false);
  const lastCounts = useRef<Record<string, number>>({});
  useEffect(() => {
    if (manualPick) return;
    let next: string | null = activeRepo;
    let bestDelta = 0;
    for (const r of repos) {
      const prev = lastCounts.current[r] ?? 0;
      const delta = (logs[r]?.length ?? 0) - prev;
      if (delta > bestDelta) {
        bestDelta = delta;
        next = r;
      }
    }
    for (const r of repos) lastCounts.current[r] = logs[r]?.length ?? 0;
    if (next === null && repos.length > 0) {
      next = repos.reduce((a, b) =>
        (logs[a]?.length ?? 0) >= (logs[b]?.length ?? 0) ? a : b,
      );
    }
    if (next !== activeRepo) setActiveRepo(next);
  }, [logs, repos, activeRepo, manualPick]);
  if (repos.length === 0) return null;
  const lines = activeRepo ? (logs[activeRepo] ?? []) : [];
  return (
    <div className="mt-2 ml-6 overflow-hidden rounded-md border border-white/[0.06] bg-black/30">
      <div className="flex items-center gap-0.5 overflow-x-auto border-b border-white/[0.06] bg-white/[0.02] px-1 py-0.5">
        {repos.map((r) => {
          const count = logs[r]?.length ?? 0;
          const isActive = r === activeRepo;
          return (
            <button
              key={r}
              type="button"
              onClick={() => {
                setManualPick(true);
                setActiveRepo(r);
              }}
              className={cn(
                "shrink-0 rounded px-2 py-0.5 font-mono text-[10px] transition-colors",
                isActive
                  ? "bg-white/10 text-white/90"
                  : "text-white/40 hover:bg-white/[0.04] hover:text-white/70",
              )}
              title={`${r}: ${count} lines`}
            >
              {r}
              <span className="ml-1 text-white/30">{count}</span>
            </button>
          );
        })}
      </div>
      <LogTail lines={lines} />
    </div>
  );
}

/** Returns true when the overlay should block the chat. */
export function shouldBlockComposer(
  phase: string | null | undefined,
): boolean {
  if (!phase) return false;
  if (phase === "ready") return false;
  if (phase === "error") return true;
  return (
    (FORK_ORDER as readonly string[]).includes(phase) ||
    (FRESH_ORDER as readonly string[]).includes(phase)
  );
}

export function ForkProgressOverlay({
  phase,
  message,
  title,
  composeLogs,
}: ForkProgressOverlayProps) {
  const detail = parseDetail(message);
  const isError = phase === "error";
  const order = orderFor(phase);
  const isFork = order === FORK_ORDER;

  return (
    <div className="flex h-full w-full flex-col overflow-auto px-6 py-8">
      <div className="mx-auto w-full max-w-xl">
        <header className="mb-6">
          <p className="text-[10px] uppercase tracking-wide text-white/30">
            {isFork ? "Fork in progress" : "Workspace starting"}
          </p>
          <h2 className="mt-1 text-base font-medium leading-snug text-white/85">
            {title?.trim() || (isFork ? "Forked mission" : "New mission")}
          </h2>
          <p className="mt-2 text-xs text-white/50">
            The chat is held until the pod is fully ready —{" "}
            {isFork && "disks claimed, "}Docker up, every compose service
            healthy.
          </p>
        </header>

        {isError && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">Fork failed</p>
                {detail?.error && (
                  <p className="mt-1 break-words font-mono text-[11px] leading-snug text-rose-200/80">
                    {detail.error}
                  </p>
                )}
                <p className="mt-2 text-rose-200/70">
                  Delete the failed fork and try again, or contact the
                  operator.
                </p>
              </div>
            </div>
          </div>
        )}

        <ol className="space-y-2.5">
          {order.map((rowPhase) => {
            const state = rowState(rowPhase, phase ?? undefined, order);
            const isCurrent = phase === rowPhase;
            const label = PHASE_LABELS[rowPhase];
            return (
              <li
                key={rowPhase}
                className={cn(
                  "rounded-md border px-3 py-2 transition-colors",
                  state === "done" &&
                    "border-emerald-500/15 bg-emerald-500/[0.03]",
                  state === "active" &&
                    "border-indigo-500/30 bg-indigo-500/[0.06]",
                  state === "pending" && "border-white/[0.05] bg-white/[0.02]",
                )}
              >
                <div className="flex items-center gap-2">
                  <StateIcon state={state} />
                  <span
                    className={cn(
                      "text-xs",
                      state === "done" && "text-white/60",
                      state === "active" && "font-medium text-white/90",
                      state === "pending" && "text-white/35",
                    )}
                  >
                    {label}
                  </span>
                  {isCurrent &&
                    detail?.events_copied != null &&
                    rowPhase === "quiescing_source" && (
                      <span className="ml-auto text-[10px] text-white/40">
                        {detail.events_copied} events copied
                      </span>
                    )}
                </div>

                {/* Per-item sub-rows for snapshotting + PVC stages */}
                {isCurrent &&
                  (rowPhase === "snapshotting" ||
                    rowPhase === "pvc_provisioning") &&
                  detail?.items && <SnapshotItemList items={detail.items} />}

                {/* Per-service sub-rows for compose stage */}
                {isCurrent &&
                  rowPhase === "compose_starting" &&
                  detail?.services && (
                    <ComposeServiceList services={detail.services} />
                  )}

                {/* Tabbed console for `docker compose up -d` output —
                    one tab per repo, shared scrolling pane. Streamed
                    by `src/api/repo-… run_compose_up_with_logs`. */}
                {isCurrent &&
                  rowPhase === "compose_starting" &&
                  composeLogs && <ComposeLogConsole logs={composeLogs} />}

                {/* Plaintext sub-message if backend used a non-JSON pod_message
                    (legacy) and this row is active. */}
                {isCurrent &&
                  detail &&
                  !detail.items &&
                  !detail.services &&
                  detail.sub && (
                    <p className="mt-1 pl-6 text-[11px] text-white/45">
                      {detail.sub}
                    </p>
                  )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
