"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw,
  GitBranch,
  FileText,
  X,
  ChevronRight,
  ChevronDown,
  Columns,
  AlignJustify,
  Folder,
  FolderOpen,
  File as FileIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api/core";
import { authHeader } from "@/lib/auth";
import { getRuntimeApiBase } from "@/lib/settings";

type DiffViewMode = "split" | "unified";

const VIEW_MODE_STORAGE_KEY = "changes-panel.view-mode";
const LEFT_WIDTH_STORAGE_KEY = "changes-panel.left-pct";
const REPO_PANE_HEIGHT_STORAGE_KEY = "changes-panel.repo-pane-pct";

function readStoredViewMode(): DiffViewMode {
  if (typeof window === "undefined") return "split";
  const v = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  return v === "unified" ? "unified" : "split";
}

function readStoredNumber(key: string, fallback: number, min: number, max: number) {
  if (typeof window === "undefined") return fallback;
  const v = Number(window.localStorage.getItem(key));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

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
  const [viewMode, setViewMode] = useState<DiffViewMode>(() =>
    readStoredViewMode(),
  );
  const [leftPct, setLeftPct] = useState<number>(() =>
    readStoredNumber(LEFT_WIDTH_STORAGE_KEY, 28, 15, 60),
  );
  const [repoPanePct, setRepoPanePct] = useState<number>(() =>
    readStoredNumber(REPO_PANE_HEIGHT_STORAGE_KEY, 35, 15, 80),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LEFT_WIDTH_STORAGE_KEY, String(leftPct));
  }, [leftPct]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      REPO_PANE_HEIGHT_STORAGE_KEY,
      String(repoPanePct),
    );
  }, [repoPanePct]);

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

  // Drag-to-resize handler for the vertical divider between left
  // (file lists) and right (diff). Track in pct of container width
  // so the layout scales with the modal viewport.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onResizeStart = useCallback(
    (startEvent: React.MouseEvent) => {
      startEvent.preventDefault();
      const start = containerRef.current?.getBoundingClientRect();
      if (!start) return;
      const onMove = (e: MouseEvent) => {
        const pct = ((e.clientX - start.left) / start.width) * 100;
        setLeftPct(Math.min(60, Math.max(15, pct)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [],
  );

  // Repo-pane vertical resize (top: repo tree, bottom: changed
  // files). pct measured against the left column's height.
  const leftColumnRef = useRef<HTMLDivElement | null>(null);
  const onRepoPaneResizeStart = useCallback((startEvent: React.MouseEvent) => {
    startEvent.preventDefault();
    const start = leftColumnRef.current?.getBoundingClientRect();
    if (!start) return;
    const onMove = (e: MouseEvent) => {
      const pct = ((e.clientY - start.top) / start.height) * 100;
      setRepoPanePct(Math.min(80, Math.max(15, pct)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

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
        <div className="flex items-center gap-1.5">
          {/* Split / Unified toggle. Two-state button so it's
              clear which view is active. Preference persists in
              localStorage (read on mount). */}
          <div className="flex items-center rounded-md border border-white/[0.06] bg-white/[0.02] p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("split")}
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 text-[11px] rounded transition-colors",
                viewMode === "split"
                  ? "bg-indigo-500/20 text-indigo-200"
                  : "text-white/50 hover:text-white/80",
              )}
              title="Split view (side-by-side)"
            >
              <Columns className="h-3 w-3" />
              Split
            </button>
            <button
              type="button"
              onClick={() => setViewMode("unified")}
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 text-[11px] rounded transition-colors",
                viewMode === "unified"
                  ? "bg-indigo-500/20 text-indigo-200"
                  : "text-white/50 hover:text-white/80",
              )}
              title="Unified view (single column)"
            >
              <AlignJustify className="h-3 w-3" />
              Unified
            </button>
          </div>
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

      <div ref={containerRef} className="flex-1 min-h-0 flex">
        {/* Left column: stacked repo browser (top) + changed-files
            tree (bottom), separated by a horizontal drag handle. */}
        <div
          ref={leftColumnRef}
          className="shrink-0 flex flex-col border-r border-white/[0.06] min-w-0"
          style={{ width: `${leftPct}%` }}
        >
          {/* Repo browser pane */}
          <div
            className="flex flex-col min-h-0 border-b border-white/[0.06]"
            style={{ height: `${repoPanePct}%` }}
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.04] text-[11px] uppercase tracking-wide text-white/40">
              <Folder className="h-3 w-3" />
              Repos
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
              {data?.repos.length === 0 && !loading && (
                <p className="px-3 py-2 text-xs text-white/40">
                  No repos in <code>/workspaces/repos</code>.
                </p>
              )}
              {data?.repos.map((repo) => (
                <RepoTreeNode
                  key={repo.name}
                  missionId={missionId}
                  repoName={repo.name}
                  rootPath=""
                  depth={0}
                />
              ))}
            </div>
          </div>

          {/* Horizontal divider between repo pane and changed files */}
          <div
            onMouseDown={onRepoPaneResizeStart}
            className="h-1 cursor-row-resize bg-white/[0.04] hover:bg-indigo-500/40 transition-colors shrink-0"
            title="Drag to resize"
          />

          {/* Changed-files tree */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.04] text-[11px] uppercase tracking-wide text-white/40">
              <FileText className="h-3 w-3" />
              Changed
              {totalFiles > 0 && (
                <span className="ml-1 text-white/30 font-mono">
                  ({totalFiles})
                </span>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
              {!data && loading && (
                <div className="p-3 text-sm text-white/40">Loading…</div>
              )}
              {data && totalFiles === 0 && !data.unavailable && (
                <div className="p-3 text-sm text-white/40">
                  No uncommitted changes in any cloned repo.
                </div>
              )}
              {data?.repos.map((repo) => (
                <ChangedFilesTree
                  key={repo.name}
                  repo={repo}
                  selectedPath={selectedPath}
                  onSelect={setSelectedPath}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Vertical drag handle between left + right */}
        <div
          onMouseDown={onResizeStart}
          className="w-1 cursor-col-resize bg-white/[0.04] hover:bg-indigo-500/40 transition-colors shrink-0"
          title="Drag to resize"
        />

        {/* Diff viewer */}
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
              {viewMode === "split" ? (
                <SideBySideDiff
                  head={selectedFile.head_content}
                  worktree={selectedFile.worktree_content}
                />
              ) : (
                <UnifiedDiff
                  head={selectedFile.head_content}
                  worktree={selectedFile.worktree_content}
                />
              )}
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
  // `min-w-max` makes the row track its content width instead of the
  // overflow-auto viewport. Without it the row's bg (the green/red
  // tint) only painted the visible portion — once the user scrolled
  // right, the line continued as a bare strip with no highlight.
  // `whitespace-pre` on the inner span preserves spaces but does not
  // expand the parent, so the wrap-min has to come from the row.
  return (
    <div className={cn("flex min-w-max", cls)}>
      <span className="sticky left-0 select-none w-12 shrink-0 text-right pr-2 text-white/30 border-r border-white/[0.04] bg-inherit">
        {no}
      </span>
      <span className="flex-1 px-2 whitespace-pre">{children}</span>
    </div>
  );
}

/**
 * Unified diff view — single column with context + delete +
 * insert rows interleaved. Uses the same `lineDiff` LCS that the
 * split view uses but flattens the rows into one pane. Number
 * column shows BOTH sides (head | worktree).
 */
function UnifiedDiff({
  head,
  worktree,
}: {
  head: string | null;
  worktree: string | null;
}) {
  const headLines = useMemo(() => (head ?? "").split("\n"), [head]);
  const wtLines = useMemo(() => (worktree ?? "").split("\n"), [worktree]);
  const trim = (arr: string[]) =>
    arr.length > 0 && arr[arr.length - 1] === "" ? arr.slice(0, -1) : arr;
  const rows = useMemo(
    () => lineDiff(trim(headLines), trim(wtLines)),
    [headLines, wtLines],
  );

  if (head === null && worktree === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-white/40">
        (no content)
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <pre className="font-mono text-sm leading-snug">
        {rows.map((row, i) => {
          if (row.kind === "same") {
            return (
              <UnifiedRow
                key={i}
                leftNo={String(row.leftNo)}
                rightNo={String(row.rightNo)}
                cls="text-white/75"
                prefix=" "
                text={row.left}
              />
            );
          }
          if (row.kind === "del") {
            return (
              <UnifiedRow
                key={i}
                leftNo={String(row.leftNo)}
                rightNo=""
                cls="bg-red-500/10 text-red-200"
                prefix="-"
                text={row.left}
              />
            );
          }
          return (
            <UnifiedRow
              key={i}
              leftNo=""
              rightNo={String(row.rightNo)}
              cls="bg-emerald-500/10 text-emerald-200"
              prefix="+"
              text={row.right}
            />
          );
        })}
      </pre>
    </div>
  );
}

function UnifiedRow({
  leftNo,
  rightNo,
  cls,
  prefix,
  text,
}: {
  leftNo: string;
  rightNo: string;
  cls: string;
  prefix: string;
  text: string;
}) {
  return (
    <div className={cn("flex min-w-max", cls)}>
      <span className="sticky left-0 select-none flex shrink-0 bg-inherit border-r border-white/[0.04]">
        <span className="w-12 text-right pr-2 text-white/30 border-r border-white/[0.04]">
          {leftNo}
        </span>
        <span className="w-12 text-right pr-2 text-white/30">{rightNo}</span>
      </span>
      <span className="flex-1 px-2 whitespace-pre">
        {prefix}
        {text}
      </span>
    </div>
  );
}

/**
 * Collapsible tree of the *changed* files in a single repo.
 * Builds a directory map from `repo.files[].path`, then renders
 * nested directories with chevron-toggleable expansion. Files
 * stay as buttons that drive selection.
 */
type TreeNode = {
  name: string;
  fullPath: string; // relative to repo root
  children: TreeNode[];
  // Leaf nodes carry the original file info to render status badges
  // without another lookup.
  file?: MissionChangedFile;
};

function buildTree(files: MissionChangedFile[]): TreeNode {
  const root: TreeNode = { name: "", fullPath: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLeaf = i === parts.length - 1;
      let next = cur.children.find((c) => c.name === name);
      if (!next) {
        next = {
          name,
          fullPath:
            cur.fullPath === "" ? name : `${cur.fullPath}/${name}`,
          children: [],
        };
        cur.children.push(next);
      }
      if (isLeaf) next.file = f;
      cur = next;
    }
  }
  // Sort: dirs (have children, no file) before files, then by name.
  const sortNode = (node: TreeNode) => {
    node.children.sort((a, b) => {
      const aDir = a.children.length > 0 && !a.file;
      const bDir = b.children.length > 0 && !b.file;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function ChangedFilesTree({
  repo,
  selectedPath,
  onSelect,
}: {
  repo: MissionChangedRepo;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(repo.files), [repo.files]);
  return (
    <div className="py-1">
      <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-white/40 font-mono">
        {repo.name}
        <span className="ml-1 text-white/30">({repo.files.length})</span>
      </div>
      <ul>
        {tree.children.map((child) => (
          <ChangedTreeRow
            key={child.fullPath}
            node={child}
            repoName={repo.name}
            depth={0}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

function ChangedTreeRow({
  node,
  repoName,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  repoName: string;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const isLeaf = !!node.file;
  // Auto-expand on first render so the tree is useful without clicks.
  // Users can collapse — state is per-instance.
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: 8 + depth * 12 };

  if (isLeaf && node.file) {
    const key = `${repoName}/${node.file.path}`;
    const isActive = key === selectedPath;
    return (
      <li>
        <button
          type="button"
          onClick={() => onSelect(key)}
          style={indent}
          className={cn(
            "w-full flex items-center gap-1.5 pr-2 py-1 text-sm text-left hover:bg-white/[0.04]",
            isActive && "bg-indigo-500/15 text-indigo-200",
          )}
          title={node.file.path}
        >
          <StatusBadge status={node.file.status} />
          <FileIcon className="h-3 w-3 text-white/40 shrink-0" />
          <span className="font-mono truncate">{node.name}</span>
        </button>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        style={indent}
        className="w-full flex items-center gap-1 pr-2 py-1 text-[12px] text-white/60 hover:bg-white/[0.04]"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {open ? (
          <FolderOpen className="h-3 w-3 text-amber-400/70 shrink-0" />
        ) : (
          <Folder className="h-3 w-3 text-amber-400/70 shrink-0" />
        )}
        <span className="font-mono truncate">{node.name}</span>
      </button>
      {open && (
        <ul>
          {node.children.map((child) => (
            <ChangedTreeRow
              key={child.fullPath}
              node={child}
              repoName={repoName}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Recursive repo-tree node. Lazy-loads its children via the
 * `/api/control/missions/:id/repo-tree` endpoint when first
 * expanded — keeps the initial render light even on large repos.
 * Read-only browse: clicking a file does not select it in the
 * diff viewer (since the file may not have any changes).
 */
interface RepoTreeEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
}

function RepoTreeNode({
  missionId,
  repoName,
  rootPath,
  depth,
}: {
  missionId: string;
  repoName: string;
  rootPath: string; // relative to /workspaces/repos/<repoName>
  depth: number;
}) {
  // Root node (repoName) is opened by default; subdirs require a click.
  const isRoot = depth === 0;
  const [open, setOpen] = useState(isRoot);
  const [entries, setEntries] = useState<RepoTreeEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadChildren = useCallback(async () => {
    if (loading || entries !== null) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("repo", repoName);
      if (rootPath) params.set("path", rootPath);
      const API_BASE = getRuntimeApiBase();
      const res = await fetch(
        `${API_BASE}/api/control/missions/${missionId}/repo-tree?${params.toString()}`,
        { headers: { ...authHeader() } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { entries: RepoTreeEntry[] } = await res.json();
      setEntries(data.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [missionId, repoName, rootPath, loading, entries]);

  useEffect(() => {
    if (open) void loadChildren();
  }, [open, loadChildren]);

  const indent = { paddingLeft: 8 + depth * 12 };
  const label = isRoot ? repoName : rootPath.split("/").pop() || rootPath;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        style={indent}
        className={cn(
          "w-full flex items-center gap-1 pr-2 py-1 text-[12px] text-white/70 hover:bg-white/[0.04]",
          isRoot && "font-medium text-white/85",
        )}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {open ? (
          <FolderOpen className="h-3 w-3 text-amber-400/70 shrink-0" />
        ) : (
          <Folder className="h-3 w-3 text-amber-400/70 shrink-0" />
        )}
        <span className="font-mono truncate">{label}</span>
      </button>
      {open && (
        <div>
          {loading && (
            <p className="px-2 py-1 text-[11px] text-white/40" style={indent}>
              Loading…
            </p>
          )}
          {error && (
            <p
              className="px-2 py-1 text-[11px] text-red-300/80"
              style={indent}
            >
              {error}
            </p>
          )}
          {entries?.map((entry) => {
            const childPath = rootPath
              ? `${rootPath}/${entry.name}`
              : entry.name;
            if (entry.kind === "dir") {
              return (
                <RepoTreeNode
                  key={childPath}
                  missionId={missionId}
                  repoName={repoName}
                  rootPath={childPath}
                  depth={depth + 1}
                />
              );
            }
            return (
              <div
                key={childPath}
                style={{ paddingLeft: 8 + (depth + 1) * 12 }}
                className="flex items-center gap-1 pr-2 py-1 text-[12px] text-white/60"
                title={childPath}
              >
                <span className="h-3 w-3 shrink-0" aria-hidden="true" />
                <FileIcon className="h-3 w-3 text-white/40 shrink-0" />
                <span className="font-mono truncate">{entry.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
