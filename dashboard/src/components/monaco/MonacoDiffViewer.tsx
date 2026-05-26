"use client";

import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import type { DiffOnMount, Monaco } from "@monaco-editor/react";
import {
  ensureTheme,
  ensureTypeScriptDefaults,
  languageForPath,
} from "./setup";

const DiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.DiffEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-sm text-white/40">
        Loading editor…
      </div>
    ),
  },
);

interface Props {
  /** Path used for language detection — e.g. `src/app.tsx`. */
  path: string;
  /** HEAD content (left side). `null` ⇒ new file (no head). */
  head: string | null;
  /** Worktree content (right side). `null` ⇒ deleted file. */
  worktree: string | null;
  /** Layout: side-by-side (split) vs inline (unified). */
  splitView: boolean;
}

/**
 * Monaco's built-in DiffEditor. It handles:
 *  - syntax highlighting (per language) on both sides
 *  - line-aligned add/remove decorations
 *  - synchronised scroll
 *  - Cmd/Ctrl-F find inside the diff
 *  - inline (`renderSideBySide=false`) vs split layout
 *
 * Read-only — editing diffs in-place would write back to HEAD,
 * which is rarely what you want. The `Editor` view (separate
 * component) is the editable surface.
 */
export function MonacoDiffViewer({ path, head, worktree, splitView }: Props) {
  // Stable container ref so we can imperatively layout() the
  // editor on resize — Monaco only re-measures on its own when the
  // window resizes, not when our flex column changes width.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<{ layout: () => void } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      editorRef.current?.layout();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onMount: DiffOnMount = (editor, monaco: Monaco) => {
    ensureTheme(monaco);
    ensureTypeScriptDefaults(monaco);
    monaco.editor.setTheme("forgecart-dark");
    editorRef.current = {
      layout: () => editor.layout(),
    };
    // Slight nudge: Monaco caches layout on first mount and
    // sometimes initialises at 0×0 when the parent grows
    // post-mount (e.g. modal animation). Schedule one re-layout
    // after a microtask so the geometry is correct.
    queueMicrotask(() => editor.layout());
  };

  if (head === null && worktree === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-white/40">
        (no content)
      </div>
    );
  }

  const language = languageForPath(path);
  return (
    <div ref={containerRef} className="flex-1 min-h-0 min-w-0">
      <DiffEditor
        original={head ?? ""}
        modified={worktree ?? ""}
        language={language}
        theme="forgecart-dark"
        onMount={onMount}
        options={{
          renderSideBySide: splitView,
          readOnly: true,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily:
            '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          scrollBeyondLastLine: false,
          renderWhitespace: "selection",
          wordWrap: "off",
          smoothScrolling: true,
          diffWordWrap: "off",
          // Inline tree (unified) view needs a higher line height
          // to keep adjacent +/- rows readable.
          renderOverviewRuler: true,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
