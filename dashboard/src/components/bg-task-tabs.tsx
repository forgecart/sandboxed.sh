"use client";

// BgTaskTabs — thin horizontal strip rendered above the chat
// composer. One chip per live `Bash(run_in_background:true)` task
// for the currently-viewed mission. Click a chip to expand its log
// tail in a popover anchored above the strip.
//
// State lives in `bgTasksByMission` in `control-client.tsx`,
// populated by `mission_bg_task_started` / `_log` / `_finished` SSE
// events from `src/api/background_watcher.rs`. Lifecycle: a chip
// appears when the backend's tail spawner emits its first event,
// stays through completion (flip to ✓ / ✗), then auto-dismisses 30 s
// later via a setTimeout set in the SSE handler.

import { useEffect, useRef, useState } from "react";
import { CheckCircle, Loader, AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type BgTaskEntry = {
  label: string;
  startedAt: number;
  completedAt?: number;
  status: "running" | "done" | "failed";
  lines: string[];
};

interface BgTaskTabsProps {
  /** `Record<shellId, entry>` for the viewing mission. */
  tasks: Record<string, BgTaskEntry> | null | undefined;
}

function elapsed(startedAt: number, completedAt: number | undefined): string {
  const end = completedAt ?? Date.now();
  const secs = Math.max(0, Math.floor((end - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m${remSecs.toString().padStart(2, "0")}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${(mins % 60).toString().padStart(2, "0")}m`;
}

function LogPopover({
  entry,
  onClose,
}: {
  entry: BgTaskEntry;
  onClose: () => void;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entry.lines.length]);
  // Show the last 50 lines; the underlying ring buffer holds 500.
  const visible = entry.lines.slice(-50);
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 max-w-3xl rounded-md border border-white/10 bg-black/95 shadow-xl">
      <div className="flex items-center justify-between border-b border-white/10 px-2 py-1 text-[10px]">
        <span className="truncate font-mono text-white/70" title={entry.label}>
          {entry.label}
        </span>
        <span className="ml-2 flex items-center gap-2">
          <span className="text-white/40">
            {entry.lines.length} lines · {elapsed(entry.startedAt, entry.completedAt)}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-0.5 text-white/40 hover:bg-white/[0.05] hover:text-white/80"
            title="Close"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      </div>
      <pre
        ref={ref}
        className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[10px] leading-snug text-white/60"
      >
        {visible.length === 0 ? (
          <span className="italic text-white/30">
            (waiting for first output line…)
          </span>
        ) : (
          visible.join("\n")
        )}
      </pre>
    </div>
  );
}

export function BgTaskTabs({ tasks }: BgTaskTabsProps) {
  const [openShell, setOpenShell] = useState<string | null>(null);
  const ids = tasks ? Object.keys(tasks) : [];
  // Drop the open popover if its task has been auto-dismissed.
  useEffect(() => {
    if (openShell && (!tasks || !tasks[openShell])) setOpenShell(null);
  }, [openShell, tasks]);
  if (ids.length === 0 || !tasks) return null;
  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1 border-b border-white/[0.05] bg-black/30 px-2 py-1">
        <span className="text-[10px] uppercase tracking-wide text-white/30">
          bg tasks
        </span>
        {ids.map((shellId) => {
          const entry = tasks[shellId];
          const isOpen = openShell === shellId;
          const status = entry.status;
          return (
            <button
              key={shellId}
              type="button"
              onClick={() => setOpenShell(isOpen ? null : shellId)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] transition-colors",
                isOpen
                  ? "bg-white/10 text-white/90"
                  : "text-white/50 hover:bg-white/[0.04] hover:text-white/80",
              )}
              title={entry.label}
            >
              {status === "running" ? (
                <Loader className="h-3 w-3 animate-spin text-indigo-400" />
              ) : status === "done" ? (
                <CheckCircle className="h-3 w-3 text-emerald-400" />
              ) : (
                <AlertTriangle className="h-3 w-3 text-rose-400" />
              )}
              <span className="max-w-[16rem] truncate">{entry.label}</span>
              <span className="text-white/30">
                {entry.lines.length}
                {" · "}
                {elapsed(entry.startedAt, entry.completedAt)}
              </span>
            </button>
          );
        })}
      </div>
      {openShell && tasks[openShell] && (
        <LogPopover
          entry={tasks[openShell]}
          onClose={() => setOpenShell(null)}
        />
      )}
    </div>
  );
}
