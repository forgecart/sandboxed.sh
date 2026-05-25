"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, GitBranch, FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api/core";

interface MissionChangedFile {
  path: string;
  status: string;
  diff: string;
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
 * Per-mission code-changes drawer. Lists every modified / added /
 * deleted file across all cloned repos inside the per-mission pod
 * with a unified-diff viewer. Lazily fetched the first time the
 * user opens the tab; manual refresh available.
 *
 * Layout: file tree on the left, unified diff on the right. A diff
 * is rendered with simple JSX (no library) — color the line prefix
 * (`+` green, `-` red, ` ` muted, `@@` hunk header indigo).
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
      // Auto-select first file when none selected.
      const first = res.repos[0]?.files[0];
      setSelectedPath((cur) => cur ?? (first ? `${res.repos[0].name}/${first.path}` : null));
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
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
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
            <div className="p-3 text-xs text-white/40">Loading…</div>
          )}
          {data && totalFiles === 0 && !data.unavailable && (
            <div className="p-3 text-xs text-white/40">
              No uncommitted changes in any cloned repo.
            </div>
          )}
          {data?.repos.map((repo) => (
            <div key={repo.name} className="py-1">
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-white/40 font-mono">
                {repo.name}
                <span className="ml-1 text-white/30">({repo.files.length})</span>
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
                          "w-full flex items-center gap-1.5 px-3 py-1 text-xs text-left hover:bg-white/[0.04]",
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

        {/* Diff viewer */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {selectedFile ? (
            <div>
              <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 bg-[#0d0d0d]/95 border-b border-white/[0.06] text-xs">
                <FileText className="h-3.5 w-3.5 text-white/40" />
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
              <DiffView diff={selectedFile.diff} />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-white/40">
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

/**
 * Unified diff renderer. Splits on `\n` and colours each line by
 * leading char:
 *   `+` → emerald   (added line)
 *   `-` → red       (removed)
 *   `@@` → indigo   (hunk header)
 *   `diff --git`, `index`, `---`, `+++`, `new file`, `deleted file`,
 *   `Binary` → muted (file header)
 *   anything else → text-white/70 (context line)
 */
function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  return (
    <pre className="font-mono text-[11px] leading-tight text-white/70 px-4 py-2 whitespace-pre">
      {lines.map((line, i) => {
        let cls = "text-white/70";
        if (line.startsWith("+++") || line.startsWith("---")) {
          cls = "text-white/40";
        } else if (line.startsWith("+")) {
          cls = "text-emerald-400 bg-emerald-500/5";
        } else if (line.startsWith("-")) {
          cls = "text-red-400 bg-red-500/5";
        } else if (line.startsWith("@@")) {
          cls = "text-indigo-300 bg-indigo-500/10";
        } else if (
          line.startsWith("diff --git") ||
          line.startsWith("index ") ||
          line.startsWith("new file") ||
          line.startsWith("deleted file") ||
          line.startsWith("Binary ")
        ) {
          cls = "text-white/30";
        }
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
