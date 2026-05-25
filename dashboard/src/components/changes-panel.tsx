"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, GitBranch, FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api/core";

interface MissionChangedFile {
  path: string;
  status: string;
  diff: string;
  head_content: string | null;
  worktree_content: string | null;
  truncated: boolean;
}

interface MissionChangedRepo {
  name: string;
  files: MissionChangedFile[];
}

interface MissionChangesResponse {
  mission_id: string;
  repos: MissionChangedRepo[];
  unavailable: boolean;
}

/**
 * Per-mission code-changes drawer styled like a PR-review pane.
 *
 * Layout (left → right):
 *   1. File tree (grouped by repo, with status badges)
 *   2. Side-by-side code editor: HEAD content (left) | worktree
 *      content (right), both monospace + line numbers, with
 *      added/removed lines highlighted per a Myers line diff
 *      computed client-side from the two contents.
 *   3. Synchronized vertical scroll across the two panes.
 *
 * For untracked files we render only the right pane (full content
 * as "added"). For deleted files only the left pane (as "removed").
 */
export function ChangesPanel({
  missionId,
  onClose,
}: {
  missionId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<MissionChangesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<MissionChangesResponse>(
        `/api/control/missions/${missionId}/changes`,
        "Failed to load changes",
      );
      setData(res);
      const first = res.repos[0]?.files[0];
      setSelectedPath(
        (cur) => cur ?? (first ? `${res.repos[0].name}/${first.path}` : null),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionId]);

  const totalFiles = useMemo(
    () => data?.repos.reduce((acc, r) => acc + r.files.length, 0) ?? 0,
    [data],
  );

  const selectedFile = useMemo(() => {
    if (!data || !selectedPath) return null;
    for (const repo of data.repos) {
      for (const f of repo.files) {
        if (`${repo.name}/${f.path}` === selectedPath) {
          return { repo: repo.name, ...f };
        }
      }
    }
    return null;
  }, [data, selectedPath]);

  return (
    <div className="flex flex-col h-full rounded-2xl glass-panel border border-white/[0.06] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-indigo-400" />
          <span className="text-sm font-medium text-white/90">Changes</span>
          {totalFiles > 0 && (
            <span className="text-xs text-white/40 font-mono">{totalFiles}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className="p-1 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/70 transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/70 transition-colors"
            title="Close changes panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 text-xs text-red-300 bg-red-500/10 border-b border-red-500/20">
          {error}
        </div>
      )}
      {data?.unavailable && (
        <div className="px-4 py-3 text-xs text-amber-300 bg-amber-500/10 border-b border-amber-500/20">
          Per-mission pod isn&apos;t reachable. Changes view only works on
          K8sPod-backed missions with cloned repos.
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {/* File tree */}
        <div className="w-72 shrink-0 border-r border-white/[0.06] overflow-y-auto">
          {!data && loading && (
            <div className="p-3 text-sm text-white/40">Loading…</div>
          )}
          {data && totalFiles === 0 && !data.unavailable && (
            <div className="p-3 text-sm text-white/40">
              No uncommitted changes in any cloned repo.
            </div>
          )}
          {data?.repos.map((repo) => (
            <div key={repo.name} className="py-1">
              <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-white/40 font-mono">
                {repo.name}
                <span className="ml-1 text-white/30">
                  ({repo.files.length})
                </span>
              </div>
              <ul>
                {repo.files.map((f) => {
                  const key = `${repo.name}/${f.path}`;
                  const isActive = key === selectedPath;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => setSelectedPath(key)}
                        className={cn(
                          "w-full flex items-center gap-1.5 px-3 py-1 text-sm text-left hover:bg-white/[0.04]",
                          isActive && "bg-indigo-500/15 text-indigo-200",
                        )}
                        title={f.path}
                      >
                        <StatusBadge status={f.status} />
                        <span className="font-mono truncate">{f.path}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        {/* Code editor / diff viewer */}
        <div className="flex-1 min-w-0 flex flex-col">
          {selectedFile ? (
            <>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.06] text-sm bg-[#0d0d0d]/80">
                <FileText className="h-4 w-4 text-white/40" />
                <span className="font-mono text-white/80 truncate">
                  {selectedFile.repo}/{selectedFile.path}
                </span>
                <StatusBadge status={selectedFile.status} />
                {selectedFile.truncated && (
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-amber-400">
                    truncated
                  </span>
                )}
              </div>
              <SideBySideDiff
                head={selectedFile.head_content}
                worktree={selectedFile.worktree_content}
              />
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-white/40">
              {data && totalFiles > 0 ? "Select a file" : ""}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    M: { label: "M", cls: "bg-amber-500/20 text-amber-300" },
    "M ": { label: "M", cls: "bg-amber-500/20 text-amber-300" },
    " M": { label: "M", cls: "bg-amber-500/20 text-amber-300" },
    MM: { label: "M", cls: "bg-amber-500/20 text-amber-300" },
    A: { label: "A", cls: "bg-emerald-500/20 text-emerald-300" },
    "A ": { label: "A", cls: "bg-emerald-500/20 text-emerald-300" },
    " A": { label: "A", cls: "bg-emerald-500/20 text-emerald-300" },
    D: { label: "D", cls: "bg-red-500/20 text-red-300" },
    "D ": { label: "D", cls: "bg-red-500/20 text-red-300" },
    " D": { label: "D", cls: "bg-red-500/20 text-red-300" },
    "??": { label: "U", cls: "bg-blue-500/20 text-blue-300" },
  };
  const entry = map[status] ?? {
    label: status.trim() || "?",
    cls: "bg-white/10 text-white/60",
  };
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center justify-center w-5 h-4 rounded text-[10px] font-mono font-medium",
        entry.cls,
      )}
      title={`git status: ${status}`}
    >
      {entry.label}
    </span>
  );
}

// Tiny LCS-based line diff. Returns one Op per OUTPUT row.
// `kind` semantics:
//   "same"  → context (both panes show the line)
//   "del"   → removed from head (left pane shows it red, right blank)
//   "add"   → added to worktree (left blank, right shows green)
// We render both panes by aligning del/add into the same row index
// so vertical scrolling stays in lockstep.
type DiffRow =
  | { kind: "same"; left: string; right: string; leftNo: number; rightNo: number }
  | { kind: "del"; left: string; leftNo: number }
  | { kind: "add"; right: string; rightNo: number };

function lineDiff(a: string[], b: string[]): DiffRow[] {
  // Build LCS table — O(n*m). Files are capped at 256KB so worst
  // case ~8k * 8k = 64M cells which is too slow; cap the diff
  // calculation at 5k lines per side and treat overflow as
  // unaligned (alternating add/del at the end).
  const N = a.length;
  const M = b.length;
  const cap = 5000;
  if (N > cap || M > cap) {
    // Bail out of LCS: just stack head as "del" then worktree as
    // "add". User can still read both files but loses alignment.
    const rows: DiffRow[] = [];
    for (let i = 0; i < N; i++) {
      rows.push({ kind: "del", left: a[i], leftNo: i + 1 });
    }
    for (let j = 0; j < M; j++) {
      rows.push({ kind: "add", right: b[j], rightNo: j + 1 });
    }
    return rows;
  }
  // Use Uint32Array for the table — far less GC pressure than Array<number>.
  const stride = M + 1;
  const lcs = new Uint32Array((N + 1) * stride);
  for (let i = 1; i <= N; i++) {
    const baseI = i * stride;
    const baseIm1 = (i - 1) * stride;
    for (let j = 1; j <= M; j++) {
      if (a[i - 1] === b[j - 1]) {
        lcs[baseI + j] = lcs[baseIm1 + j - 1] + 1;
      } else {
        const top = lcs[baseIm1 + j];
        const left = lcs[baseI + j - 1];
        lcs[baseI + j] = top >= left ? top : left;
      }
    }
  }
  // Backtrack to produce DiffRow[].
  const rows: DiffRow[] = [];
  let i = N;
  let j = M;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      rows.push({
        kind: "same",
        left: a[i - 1],
        right: b[j - 1],
        leftNo: i,
        rightNo: j,
      });
      i--;
      j--;
    } else if (lcs[(i - 1) * stride + j] >= lcs[i * stride + j - 1]) {
      rows.push({ kind: "del", left: a[i - 1], leftNo: i });
      i--;
    } else {
      rows.push({ kind: "add", right: b[j - 1], rightNo: j });
      j--;
    }
  }
  while (i > 0) {
    rows.push({ kind: "del", left: a[i - 1], leftNo: i });
    i--;
  }
  while (j > 0) {
    rows.push({ kind: "add", right: b[j - 1], rightNo: j });
    j--;
  }
  rows.reverse();
  return rows;
}

function SideBySideDiff({
  head,
  worktree,
}: {
  head: string | null;
  worktree: string | null;
}) {
  const headLines = useMemo(() => (head ?? "").split("\n"), [head]);
  const wtLines = useMemo(() => (worktree ?? "").split("\n"), [worktree]);
  // Trim trailing empty line that `split("\n")` introduces when the
  // string ends in `\n` — otherwise every file shows an extra blank
  // "same" row at the bottom.
  const trim = (arr: string[]) =>
    arr.length > 0 && arr[arr.length - 1] === ""
      ? arr.slice(0, -1)
      : arr;
  const rows = useMemo(
    () => lineDiff(trim(headLines), trim(wtLines)),
    [headLines, wtLines],
  );

  // Sync scrolling between left and right panes.
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const syncing = useRef(false);
  useEffect(() => {
    const onLeft = () => {
      if (syncing.current || !leftRef.current || !rightRef.current) return;
      syncing.current = true;
      rightRef.current.scrollTop = leftRef.current.scrollTop;
      requestAnimationFrame(() => (syncing.current = false));
    };
    const onRight = () => {
      if (syncing.current || !leftRef.current || !rightRef.current) return;
      syncing.current = true;
      leftRef.current.scrollTop = rightRef.current.scrollTop;
      requestAnimationFrame(() => (syncing.current = false));
    };
    const l = leftRef.current;
    const r = rightRef.current;
    l?.addEventListener("scroll", onLeft, { passive: true });
    r?.addEventListener("scroll", onRight, { passive: true });
    return () => {
      l?.removeEventListener("scroll", onLeft);
      r?.removeEventListener("scroll", onRight);
    };
  }, []);

  return (
    <div className="flex-1 min-h-0 grid grid-cols-2 divide-x divide-white/[0.06]">
      <DiffPane
        side="left"
        rows={rows}
        scrollRef={leftRef}
        empty={head === null}
        emptyLabel="(file was added — no HEAD version)"
      />
      <DiffPane
        side="right"
        rows={rows}
        scrollRef={rightRef}
        empty={worktree === null}
        emptyLabel="(file was deleted — no worktree version)"
      />
    </div>
  );
}

function DiffPane({
  side,
  rows,
  scrollRef,
  empty,
  emptyLabel,
}: {
  side: "left" | "right";
  rows: DiffRow[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  empty: boolean;
  emptyLabel: string;
}) {
  if (empty) {
    return (
      <div className="flex items-center justify-center text-sm text-white/40 italic">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div ref={scrollRef} className="overflow-auto">
      <pre className="font-mono text-sm leading-snug">
        {rows.map((row, i) => {
          if (side === "left") {
            if (row.kind === "add") {
              // Empty row to keep alignment with the right pane's
              // added line.
              return (
                <Row key={i} no="" cls="bg-white/[0.01]">
                  {" "}
                </Row>
              );
            }
            const cls =
              row.kind === "del"
                ? "bg-red-500/10 text-red-200"
                : "text-white/75";
            return (
              <Row key={i} no={String(row.leftNo)} cls={cls}>
                {row.kind === "del" ? `-${row.left}` : ` ${row.left}`}
              </Row>
            );
          } else {
            if (row.kind === "del") {
              return (
                <Row key={i} no="" cls="bg-white/[0.01]">
                  {" "}
                </Row>
              );
            }
            const cls =
              row.kind === "add"
                ? "bg-emerald-500/10 text-emerald-200"
                : "text-white/75";
            return (
              <Row key={i} no={String(row.rightNo)} cls={cls}>
                {row.kind === "add" ? `+${row.right}` : ` ${row.right}`}
              </Row>
            );
          }
        })}
      </pre>
    </div>
  );
}

function Row({
  no,
  cls,
  children,
}: {
  no: string;
  cls: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex", cls)}>
      <span className="select-none w-12 shrink-0 text-right pr-2 text-white/30 border-r border-white/[0.04]">
        {no}
      </span>
      <span className="flex-1 px-2 whitespace-pre">{children}</span>
    </div>
  );
}
