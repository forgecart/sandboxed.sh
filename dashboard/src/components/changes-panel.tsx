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
  Save,
  Search,
  Terminal as VimIcon,
  Loader2,
  AlertCircle,
  Circle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getWorkspaceStream,
  type ChangedFileChunk,
  type FsChangeEvent,
  type ListChangesReady,
  type SearchHitChunk,
} from "@/lib/workspace-stream";
import { MonacoDiffViewer } from "./monaco/MonacoDiffViewer";
import { MonacoFileEditor } from "./monaco/MonacoFileEditor";

type DiffViewMode = "split" | "unified";

const VIEW_MODE_STORAGE_KEY = "changes-panel.view-mode";
const LEFT_WIDTH_STORAGE_KEY = "changes-panel.left-pct";
const REPO_PANE_HEIGHT_STORAGE_KEY = "changes-panel.repo-pane-pct";
const VIM_STORAGE_KEY = "changes-panel.vim";

function readStoredViewMode(): DiffViewMode {
  if (typeof window === "undefined") return "split";
  const v = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  return v === "unified" ? "unified" : "split";
}

function readStoredBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const v = window.localStorage.getItem(key);
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return fallback;
}

function readStoredNumber(key: string, fallback: number, min: number, max: number) {
  if (typeof window === "undefined") return fallback;
  const v = Number(window.localStorage.getItem(key));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** One tab open in the editor area. */
interface OpenTab {
  /** Stable id: `<repo>/<path>#<kind>`. Used as React key + Map key. */
  id: string;
  repoName: string;
  filePath: string;
  kind: "diff" | "edit";
  /** Diff tabs: the changed-file payload. Loaded eagerly with the
   *  changes response so we don't re-fetch per click. */
  diff?: MissionChangedFile;
  /** Edit tabs: the current value held in the editor. */
  editValue?: string;
  /** Edit tabs: the value last persisted to the pod (for dirty
   *  detection). */
  editBaseline?: string;
  /** Edit tabs: load / save status. */
  loading?: boolean;
  saving?: boolean;
  error?: string | null;
  binary?: boolean;
  /** Edit tabs: line to reveal once on first open (used by find). */
  initialLine?: number;
  /** Edit tabs: file changed on disk while the local buffer was
   *  dirty. Banner asks the user to Reload (drop local) or Keep
   *  mine. Cleared on reload or on the next save attempt. */
  externallyModified?: boolean;
}

interface RepoSearchHit {
  file: string;
  line: number;
  snippet: string;
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
  // Real loaded/total from the streaming list_changes endpoint.
  // Replaces the prior simulated progress bar.
  const [loadProgress, setLoadProgress] = useState<{
    loaded: number;
    total: number;
  }>({ loaded: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DiffViewMode>(() =>
    readStoredViewMode(),
  );
  const [leftPct, setLeftPct] = useState<number>(() =>
    readStoredNumber(LEFT_WIDTH_STORAGE_KEY, 28, 15, 60),
  );
  const [repoPanePct, setRepoPanePct] = useState<number>(() =>
    readStoredNumber(REPO_PANE_HEIGHT_STORAGE_KEY, 35, 15, 80),
  );
  const [vimMode, setVimMode] = useState<boolean>(() =>
    readStoredBool(VIM_STORAGE_KEY, false),
  );

  // Open tabs + which one is active. Map keyed by tab.id so we
  // can update without index juggling. `tabOrder` keeps the
  // visible order in the tab bar.
  const [tabs, setTabs] = useState<Map<string, OpenTab>>(new Map());
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Project-wide find: panel visibility + query + results.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findRepo, setFindRepo] = useState<string | null>(null);
  const [findHits, setFindHits] = useState<RepoSearchHit[]>([]);
  const [findLoading, setFindLoading] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [findTruncated, setFindTruncated] = useState(false);

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
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIM_STORAGE_KEY, vimMode ? "1" : "0");
  }, [vimMode]);

  // Streaming load over the mux WS. The server first emits
  // `ready` with the full file list (we render the tree right
  // away) and then `chunk` per file as its head/worktree
  // content lands. Real progress = loaded/total from the
  // `progress` events.
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLoadProgress({ loaded: 0, total: 0 });
    const stream = getWorkspaceStream(missionId);
    try {
      await stream.stream<{ total: number }, ChangedFileChunk, ListChangesReady>(
        "list_changes",
        {},
        {
          onReady: (ready) => {
            // Materialise placeholder MissionChangedFile entries
            // so the tree renders before per-file content arrives.
            const repos: MissionChangedRepo[] = ready.repos.map((r) => ({
              name: r.name,
              files: r.files.map((f) => ({
                path: f.path,
                status: f.status,
                diff: "",
                head_content: null,
                worktree_content: null,
                truncated: false,
              })),
            }));
            setData({ mission_id: missionId, repos, unavailable: false });
            if (findRepo === null && repos.length > 0) {
              setFindRepo(repos[0].name);
            }
            setLoadProgress({ loaded: 0, total: ready.total });
          },
          onChunk: ({ file }) => {
            setData((prev) => {
              if (!prev) return prev;
              const repos = prev.repos.map((r) => {
                if (r.name !== file.repo) return r;
                return {
                  ...r,
                  files: r.files.map((f) =>
                    f.path === file.path
                      ? {
                          ...f,
                          status: file.status,
                          head_content: file.head_content,
                          worktree_content: file.worktree_content,
                          truncated: file.truncated,
                        }
                      : f,
                  ),
                };
              });
              return { ...prev, repos };
            });
          },
          onProgress: ({ loaded, total }) => setLoadProgress({ loaded, total }),
        },
      ).result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [missionId, findRepo]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionId]);

  const totalFiles = useMemo(
    () => data?.repos.reduce((acc, r) => acc + r.files.length, 0) ?? 0,
    [data],
  );

  // Tab handlers ───────────────────────────────────────────────
  const activateTab = useCallback((id: string) => setActiveTabId(id), []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setTabOrder((prev) => prev.filter((x) => x !== id));
    setActiveTabId((curr) => {
      if (curr !== id) return curr;
      // Pick the next-best tab to activate (previous in order).
      const idx = tabOrder.indexOf(id);
      const fallback =
        tabOrder[idx - 1] ?? tabOrder.find((x) => x !== id) ?? null;
      return fallback;
    });
  }, [tabOrder]);

  const openDiffTab = useCallback(
    (repoName: string, file: MissionChangedFile) => {
      const id = `${repoName}/${file.path}#diff`;
      setTabs((prev) => {
        if (prev.has(id)) return prev;
        const next = new Map(prev);
        next.set(id, {
          id,
          repoName,
          filePath: file.path,
          kind: "diff",
          diff: file,
        });
        return next;
      });
      setTabOrder((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setActiveTabId(id);
    },
    [],
  );

  const openEditTab = useCallback(
    async (repoName: string, filePath: string, initialLine?: number) => {
      const id = `${repoName}/${filePath}#edit`;
      // If already open, just focus it (and re-seek if line given).
      let exists = false;
      setTabs((prev) => {
        if (prev.has(id)) {
          exists = true;
          if (initialLine !== undefined) {
            const next = new Map(prev);
            const cur = next.get(id)!;
            next.set(id, { ...cur, initialLine });
            return next;
          }
          return prev;
        }
        const next = new Map(prev);
        next.set(id, {
          id,
          repoName,
          filePath,
          kind: "edit",
          loading: true,
          initialLine,
        });
        return next;
      });
      setTabOrder((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setActiveTabId(id);
      if (exists) return;

      // Load file content via the mux WS.
      try {
        const stream = getWorkspaceStream(missionId);
        const body = await stream.call<{
          content: string;
          binary: boolean;
          truncated: boolean;
        }>("read_file", { repo: repoName, path: filePath });
        setTabs((prev) => {
          const cur = prev.get(id);
          if (!cur) return prev;
          const next = new Map(prev);
          next.set(id, {
            ...cur,
            loading: false,
            binary: body.binary,
            editValue: body.content,
            editBaseline: body.content,
            error: null,
          });
          return next;
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setTabs((prev) => {
          const cur = prev.get(id);
          if (!cur) return prev;
          const next = new Map(prev);
          next.set(id, { ...cur, loading: false, error: msg });
          return next;
        });
      }
    },
    [missionId],
  );

  const updateEditValue = useCallback((id: string, value: string) => {
    setTabs((prev) => {
      const cur = prev.get(id);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(id, { ...cur, editValue: value });
      return next;
    });
  }, []);

  const saveTab = useCallback(
    async (id: string) => {
      const tab = tabs.get(id);
      if (!tab || tab.kind !== "edit" || tab.editValue === undefined) return;
      if (tab.editValue === tab.editBaseline) return; // not dirty
      setTabs((prev) => {
        const cur = prev.get(id);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(id, { ...cur, saving: true, error: null });
        return next;
      });
      try {
        const stream = getWorkspaceStream(missionId);
        await stream.call<{ ok: boolean }>("write_file", {
          repo: tab.repoName,
          path: tab.filePath,
          content: tab.editValue,
        });
        setTabs((prev) => {
          const cur = prev.get(id);
          if (!cur) return prev;
          const next = new Map(prev);
          next.set(id, {
            ...cur,
            saving: false,
            editBaseline: cur.editValue,
            error: null,
          });
          return next;
        });
        // Refresh the changes list — saving may have introduced a
        // new diff entry or cleared a previous one. Best-effort.
        void reload();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setTabs((prev) => {
          const cur = prev.get(id);
          if (!cur) return prev;
          const next = new Map(prev);
          next.set(id, { ...cur, saving: false, error: msg });
          return next;
        });
      }
    },
    [missionId, tabs],
  );

  const activeTab = activeTabId ? tabs.get(activeTabId) ?? null : null;

  // Pull the latest worktree content for a single edit tab and
  // replace its buffer + baseline. Used by both the explicit
  // "Reload" action in the externally-modified banner and the
  // auto-reload path when the local buffer is clean.
  const refetchEditTab = useCallback(
    async (tabId: string) => {
      const tab = tabs.get(tabId);
      if (!tab || tab.kind !== "edit") return;
      try {
        const stream = getWorkspaceStream(missionId);
        const body = await stream.call<{
          content: string;
          binary: boolean;
          truncated: boolean;
        }>("read_file", { repo: tab.repoName, path: tab.filePath });
        setTabs((prev) => {
          const cur = prev.get(tabId);
          if (!cur || cur.kind !== "edit") return prev;
          const next = new Map(prev);
          next.set(tabId, {
            ...cur,
            editValue: body.content,
            editBaseline: body.content,
            externallyModified: false,
          });
          return next;
        });
      } catch {
        // Best-effort — the next inotify tick (or the user's
        // manual Refresh) will get another chance.
      }
    },
    [missionId, tabs],
  );

  // Live file-system subscription rides on the same mux WS as
  // changes / read_file / search. On each {repo, path, event}:
  //  - Buffer CLEAN → silently refetch + replace. Monaco's
  //    onDidChangeContent triggers our LSP client's didChange so
  //    the language server stays in sync for free.
  //  - Buffer DIRTY → mark externallyModified=true; render a
  //    banner with [Reload] / [Keep mine] so the user's in-flight
  //    typing isn't clobbered.
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    if (!missionId) return;
    const stream = getWorkspaceStream(missionId);
    const unsub = stream.subscribeFsChanges((ev: FsChangeEvent) => {
      const { repo, path } = ev;
      for (const tab of tabsRef.current.values()) {
        if (tab.kind !== "edit") continue;
        if (tab.repoName !== repo || tab.filePath !== path) continue;
        const dirty = tab.editValue !== tab.editBaseline;
        if (dirty) {
          setTabs((prev) => {
            const cur = prev.get(tab.id);
            if (!cur || cur.externallyModified) return prev;
            const next = new Map(prev);
            next.set(tab.id, { ...cur, externallyModified: true });
            return next;
          });
        } else {
          void refetchEditTab(tab.id);
        }
      }
    });
    return unsub;
  }, [missionId, refetchEditTab]);

  const runSearch = useCallback(async () => {
    if (!findQuery.trim() || !findRepo) {
      setFindHits([]);
      setFindError(null);
      setFindTruncated(false);
      return;
    }
    setFindLoading(true);
    setFindError(null);
    setFindHits([]);
    setFindTruncated(false);
    try {
      const stream = getWorkspaceStream(missionId);
      const done = await stream.stream<
        { total: number; truncated: boolean },
        SearchHitChunk
      >(
        "search",
        { repo: findRepo, q: findQuery, limit: 200 },
        {
          onChunk: ({ hit }) => {
            // Append hits as they arrive — the user sees the
            // first match within milliseconds even on big repos.
            setFindHits((prev) => [...prev, hit]);
          },
        },
      ).result;
      setFindTruncated(done.truncated);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFindError(msg);
    } finally {
      setFindLoading(false);
    }
  }, [findQuery, findRepo, missionId]);

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
          {/* Vim toggle. Persisted; active state pulses a faint
              indigo so the user knows shortcuts are different now. */}
          <button
            type="button"
            onClick={() => setVimMode((p) => !p)}
            className={cn(
              "flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border transition-colors",
              vimMode
                ? "border-indigo-500/30 bg-indigo-500/15 text-indigo-200"
                : "border-white/[0.06] bg-white/[0.02] text-white/50 hover:text-white/80",
            )}
            title={vimMode ? "Disable vim keys" : "Enable vim keys"}
          >
            <VimIcon className="h-3 w-3" />
            VIM
          </button>
          {/* Project-wide find toggle */}
          <button
            type="button"
            onClick={() => setFindOpen((p) => !p)}
            className={cn(
              "p-1 rounded transition-colors",
              findOpen
                ? "bg-indigo-500/15 text-indigo-300"
                : "hover:bg-white/[0.06] text-white/40 hover:text-white/70",
            )}
            title="Find in project"
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          {/* Save active edit tab. Shown only when the active tab
              is an edit-mode file with a dirty buffer. */}
          {activeTab?.kind === "edit" &&
            activeTab.editValue !== activeTab.editBaseline && (
              <button
                type="button"
                onClick={() => void saveTab(activeTab.id)}
                disabled={activeTab.saving}
                className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15 disabled:opacity-50"
                title="Save (Cmd/Ctrl-S)"
              >
                {activeTab.saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                Save
              </button>
            )}
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

      {/* Find panel — slides in between header and body when the
          search icon is toggled. Repo dropdown + query input +
          result list; clicking a result opens the file in an
          edit tab at the matching line. */}
      {findOpen && (
        <FindPanel
          repos={data?.repos.map((r) => r.name) ?? []}
          activeRepo={findRepo}
          setActiveRepo={setFindRepo}
          query={findQuery}
          setQuery={setFindQuery}
          run={runSearch}
          loading={findLoading}
          error={findError}
          hits={findHits}
          truncated={findTruncated}
          onHit={(repo, file, line) => void openEditTab(repo, file, line)}
        />
      )}

      {/* Initial-load progress bar — surfaced only while the first
          fetch is in flight (`!data && loading`). Subsequent
          Refreshes flag the icon-spin but don't repaint this strip
          so the panel doesn't visually reset every time. */}
      <ChangesLoadProgress
        active={loading}
        loaded={loadProgress.loaded}
        total={loadProgress.total}
      />

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
                  onOpenFile={(r, p) => void openEditTab(r, p)}
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
              {/* Inline "Loading…" text dropped — the top progress
                  bar already surfaces the initial-load state, and
                  the Refresh icon spin handles subsequent fetches. */}
              {data && totalFiles === 0 && !data.unavailable && (
                <div className="p-3 text-sm text-white/40">
                  No uncommitted changes in any cloned repo.
                </div>
              )}
              {data?.repos.map((repo) => (
                <ChangedFilesTree
                  key={repo.name}
                  repo={repo}
                  activeDiffTabId={activeTabId}
                  onSelect={openDiffTab}
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

        {/* Editor area: tab bar + Monaco viewer/editor. */}
        <div className="flex-1 min-w-0 flex flex-col">
          <TabBar
            tabs={tabOrder.map((id) => tabs.get(id)!).filter(Boolean)}
            activeId={activeTabId}
            onActivate={activateTab}
            onClose={closeTab}
          />
          <div className="flex-1 min-h-0 flex flex-col bg-[#0d0d0d]">
            {activeTab ? (
              <ActiveTabBody
                tab={activeTab}
                missionId={missionId}
                splitView={viewMode === "split"}
                vim={vimMode}
                onChange={(v) => updateEditValue(activeTab.id, v)}
                onSave={() => void saveTab(activeTab.id)}
                onReload={() => void refetchEditTab(activeTab.id)}
                onKeepMine={() =>
                  setTabs((prev) => {
                    const cur = prev.get(activeTab.id);
                    if (!cur) return prev;
                    const next = new Map(prev);
                    next.set(activeTab.id, {
                      ...cur,
                      externallyModified: false,
                    });
                    return next;
                  })
                }
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-white/40">
                {data && totalFiles > 0
                  ? "Select a changed file or open one from Repos"
                  : ""}
              </div>
            )}
          </div>
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
  activeDiffTabId,
  onSelect,
}: {
  repo: MissionChangedRepo;
  activeDiffTabId: string | null;
  onSelect: (repoName: string, file: MissionChangedFile) => void;
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
            activeDiffTabId={activeDiffTabId}
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
  activeDiffTabId,
  onSelect,
}: {
  node: TreeNode;
  repoName: string;
  depth: number;
  activeDiffTabId: string | null;
  onSelect: (repoName: string, file: MissionChangedFile) => void;
}) {
  const isLeaf = !!node.file;
  // Auto-expand on first render so the tree is useful without clicks.
  // Users can collapse — state is per-instance.
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: 8 + depth * 12 };

  if (isLeaf && node.file) {
    const tabId = `${repoName}/${node.file.path}#diff`;
    const isActive = tabId === activeDiffTabId;
    return (
      <li>
        <button
          type="button"
          onClick={() => onSelect(repoName, node.file!)}
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
              activeDiffTabId={activeDiffTabId}
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
  onOpenFile,
}: {
  missionId: string;
  repoName: string;
  rootPath: string; // relative to /workspaces/repos/<repoName>
  depth: number;
  onOpenFile: (repoName: string, filePath: string) => void;
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
      const stream = getWorkspaceStream(missionId);
      const data = await stream.call<{ entries: RepoTreeEntry[] }>(
        "list_dir",
        { repo: repoName, path: rootPath },
      );
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
                  onOpenFile={onOpenFile}
                />
              );
            }
            return (
              <button
                type="button"
                key={childPath}
                onClick={() => onOpenFile(repoName, childPath)}
                style={{ paddingLeft: 8 + (depth + 1) * 12 }}
                className="w-full text-left flex items-center gap-1 pr-2 py-1 text-[12px] text-white/60 hover:bg-white/[0.04]"
                title={childPath}
              >
                <span className="h-3 w-3 shrink-0" aria-hidden="true" />
                <FileIcon className="h-3 w-3 text-white/40 shrink-0" />
                <span className="font-mono truncate">{entry.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Editor tab bar. Each tab renders the file's basename + a kind
 * pill (diff / edit), a dirty dot when an edit tab has unsaved
 * changes, and an X to close. Horizontally scrollable so a long
 * list of opens doesn't blow up the header.
 */
function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
}: {
  tabs: OpenTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  if (tabs.length === 0) {
    return (
      <div className="h-9 border-b border-white/[0.06] bg-[#0a0a0a] flex items-center px-3 text-[11px] text-white/30">
        No file open
      </div>
    );
  }
  return (
    <div className="h-9 flex items-center border-b border-white/[0.06] bg-[#0a0a0a] overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const dirty =
          tab.kind === "edit" &&
          tab.editValue !== undefined &&
          tab.editValue !== tab.editBaseline;
        const basename = tab.filePath.split("/").pop() ?? tab.filePath;
        return (
          <div
            key={tab.id}
            className={cn(
              "shrink-0 group flex items-center gap-1.5 pl-3 pr-1 py-1 border-r border-white/[0.06] text-[12px] cursor-pointer transition-colors",
              isActive
                ? "bg-[#0d0d0d] text-white"
                : "bg-transparent text-white/60 hover:bg-white/[0.03]",
            )}
            onClick={() => onActivate(tab.id)}
            title={`${tab.repoName}/${tab.filePath}`}
          >
            {tab.kind === "diff" ? (
              <GitBranch className="h-3 w-3 text-indigo-400 shrink-0" />
            ) : (
              <FileText className="h-3 w-3 text-emerald-400 shrink-0" />
            )}
            <span className="font-mono">{basename}</span>
            {dirty && (
              <Circle className="h-2 w-2 fill-amber-400 stroke-none shrink-0" />
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className="p-0.5 rounded text-white/40 hover:text-white hover:bg-white/[0.08]"
              title="Close tab"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Renders the body for the active tab. Either a Monaco DiffEditor
 * (read-only side-by-side / inline) or a full Monaco editor for
 * the file's worktree content (editable, with vim + save).
 */
function ActiveTabBody({
  tab,
  missionId,
  splitView,
  vim,
  onChange,
  onSave,
  onReload,
  onKeepMine,
}: {
  tab: OpenTab;
  missionId: string;
  splitView: boolean;
  vim: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  onReload: () => void;
  onKeepMine: () => void;
}) {
  if (tab.kind === "diff" && tab.diff) {
    return (
      <>
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-white/[0.06] text-[12px] bg-[#0d0d0d]/80">
          <FileText className="h-3.5 w-3.5 text-white/40" />
          <span className="font-mono text-white/80 truncate">
            {tab.repoName}/{tab.filePath}
          </span>
          <StatusBadge status={tab.diff.status} />
          {tab.diff.truncated && (
            <span className="ml-auto text-[10px] uppercase tracking-wide text-amber-400">
              truncated
            </span>
          )}
        </div>
        <MonacoDiffViewer
          path={tab.filePath}
          head={tab.diff.head_content}
          worktree={tab.diff.worktree_content}
          splitView={splitView}
        />
      </>
    );
  }
  // Edit mode
  if (tab.loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-white/40">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading {tab.filePath}…
      </div>
    );
  }
  if (tab.error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-sm text-red-300 gap-2 p-4">
        <AlertCircle className="h-5 w-5" />
        <span className="font-mono text-xs">{tab.error}</span>
      </div>
    );
  }
  if (tab.binary) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-white/40 italic">
        Binary file — not editable
      </div>
    );
  }
  return (
    <>
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-white/[0.06] text-[12px] bg-[#0d0d0d]/80">
        <FileText className="h-3.5 w-3.5 text-white/40" />
        <span className="font-mono text-white/80 truncate">
          {tab.repoName}/{tab.filePath}
        </span>
        {tab.editValue !== undefined && tab.editValue !== tab.editBaseline && (
          <span className="text-[10px] uppercase tracking-wide text-amber-400">
            modified
          </span>
        )}
        {tab.saving && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-300">
            <Loader2 className="h-3 w-3 animate-spin" />
            saving…
          </span>
        )}
      </div>
      {tab.externallyModified && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-[12px] text-amber-200">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            This file changed on disk while you were editing it.
          </span>
          <button
            type="button"
            onClick={onReload}
            className="px-2 py-0.5 rounded border border-amber-400/30 text-[11px] hover:bg-amber-400/15"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={onKeepMine}
            className="px-2 py-0.5 rounded border border-white/10 text-[11px] text-white/70 hover:bg-white/[0.04]"
          >
            Keep mine
          </button>
        </div>
      )}
      <MonacoFileEditor
        path={tab.filePath}
        missionId={missionId}
        repoName={tab.repoName}
        value={tab.editValue ?? ""}
        vim={vim}
        initialLine={tab.initialLine}
        onChange={onChange}
        onSave={onSave}
      />
    </>
  );
}

/**
 * Project-wide find panel. Lives between the header and the body
 * when toggled. Repo scope dropdown + query box (Enter to run) +
 * result list (clickable rows that open the matching file in an
 * editor tab focused on the matching line).
 */
function FindPanel({
  repos,
  activeRepo,
  setActiveRepo,
  query,
  setQuery,
  run,
  loading,
  error,
  hits,
  truncated,
  onHit,
}: {
  repos: string[];
  activeRepo: string | null;
  setActiveRepo: (r: string) => void;
  query: string;
  setQuery: (q: string) => void;
  run: () => void;
  loading: boolean;
  error: string | null;
  hits: RepoSearchHit[];
  truncated: boolean;
  onHit: (repo: string, file: string, line: number) => void;
}) {
  return (
    <div className="border-b border-white/[0.06] bg-[#0c0c0c]">
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="h-3.5 w-3.5 text-white/40 shrink-0" />
        <select
          value={activeRepo ?? ""}
          onChange={(e) => setActiveRepo(e.target.value)}
          className="bg-black/30 border border-white/[0.06] rounded text-[12px] text-white/80 px-2 py-1 focus:outline-none focus:border-indigo-500/40"
        >
          {repos.map((r) => (
            <option key={r} value={r} className="bg-[#0d0d0d]">
              {r}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              run();
            }
          }}
          placeholder="Regex or substring…"
          className="flex-1 bg-black/30 border border-white/[0.06] rounded text-[12px] text-white/90 px-2 py-1 placeholder:text-white/30 focus:outline-none focus:border-indigo-500/40"
        />
        <button
          type="button"
          onClick={run}
          disabled={loading || !activeRepo || !query.trim()}
          className="px-3 py-1 text-[12px] rounded bg-indigo-500/20 text-indigo-200 border border-indigo-500/30 hover:bg-indigo-500/30 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Find"}
        </button>
      </div>
      {(error || hits.length > 0 || (!loading && query.trim() && hits.length === 0)) && (
        <div className="max-h-48 overflow-y-auto border-t border-white/[0.04]">
          {error && (
            <div className="px-3 py-2 text-[11px] text-red-300">{error}</div>
          )}
          {!error && hits.length === 0 && !loading && query.trim() && (
            <div className="px-3 py-2 text-[11px] text-white/40">
              No matches.
            </div>
          )}
          {hits.map((hit, i) => (
            <button
              type="button"
              key={`${hit.file}:${hit.line}:${i}`}
              onClick={() => activeRepo && onHit(activeRepo, hit.file, hit.line)}
              className="w-full flex items-baseline gap-2 px-3 py-1 text-left text-[12px] hover:bg-white/[0.04]"
              title={`${hit.file}:${hit.line}`}
            >
              <span className="font-mono text-indigo-300 shrink-0">
                {hit.file}
                <span className="text-white/40">:{hit.line}</span>
              </span>
              <span className="font-mono text-white/60 truncate">
                {hit.snippet}
              </span>
            </button>
          ))}
          {truncated && (
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-amber-400 border-t border-white/[0.04]">
              Results truncated — refine your query
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Animated initial-load progress bar.
 *
 * Backend doesn't stream progress, so we can't show *real*
 * progress — every percentage from the server would be a lie.
 * Instead, we simulate an asymptotic ramp: percent climbs fast
 * at first, then slows as it nears 95%. Never hits 100% on its
 * own; only the `active=false` transition snaps it home. This
 * matches the cadence users expect from network requests and is
 * the same trick used by NProgress / pace.js. Time constant is
 * tuned to a ~6 s typical first-load of the changes endpoint on
 * a medium repo.
 *
 * When `active` flips false (load done or never started), the
 * bar fills to 100% with a brief animation, then fades out.
 */
/**
 * Real progress bar. The streaming list_changes endpoint emits
 * `progress { loaded, total }` events as each file's diff lands;
 * we render that ratio. `total` is the number of changed files
 * known from the initial `ready` event (which fires after a
 * single `git status` call — sub-second on most repos). While
 * we wait for `ready` (total=0), we fall back to a short
 * indeterminate ramp so the bar isn't frozen at 0%.
 */
function ChangesLoadProgress({
  active,
  loaded,
  total,
}: {
  active: boolean;
  loaded: number;
  total: number;
}) {
  const [visible, setVisible] = useState(false);
  const [warmupPct, setWarmupPct] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      setVisible(true);
      startRef.current = Date.now();
      if (total === 0) {
        // Pre-ready warmup ramp — covers the ~200 ms it takes to
        // run `git status` and emit the file list.
        const id = setInterval(() => {
          const elapsed = Date.now() - (startRef.current ?? Date.now());
          setWarmupPct(2 + 18 * (1 - Math.exp(-elapsed / 600)));
        }, 80);
        return () => clearInterval(id);
      }
      return;
    }
    const fadeOut = window.setTimeout(() => setVisible(false), 300);
    return () => window.clearTimeout(fadeOut);
  }, [active, total]);

  if (!visible) return null;
  // Real % once `total` is known. Before that, show the warmup
  // ramp so the bar isn't stuck at 0.
  const pct =
    total > 0
      ? active
        ? Math.min(100, Math.round((loaded / total) * 100))
        : 100
      : Math.floor(warmupPct);
  const label = total > 0 ? `${loaded}/${total}` : "…";
  return (
    <div
      className={cn(
        "relative h-1 bg-white/[0.04] border-b border-white/[0.06] overflow-hidden transition-opacity",
        active ? "opacity-100" : "opacity-0 duration-300",
      )}
    >
      <div
        className="absolute inset-y-0 left-0 bg-gradient-to-r from-indigo-500/80 to-emerald-500/80 transition-[width] duration-150 ease-out"
        style={{ width: `${pct}%` }}
      />
      <span
        className="absolute right-2 -top-0.5 text-[9px] font-mono text-white/40 leading-none select-none pointer-events-none"
        style={{ textShadow: "0 0 4px rgba(0,0,0,0.6)" }}
      >
        {pct}% · {label}
      </span>
    </div>
  );
}
