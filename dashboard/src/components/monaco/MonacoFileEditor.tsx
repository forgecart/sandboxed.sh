"use client";

import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import type { Monaco, OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import {
  ensureTheme,
  ensureTypeScriptDefaults,
  languageForPath,
} from "./setup";
import { getLspClient, modelUriFor } from "./lsp-pool";
import type { LspClient } from "./lsp-client";

const Editor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.Editor),
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
  /** Path used for language detection. */
  path: string;
  /** Current value (controlled). */
  value: string;
  onChange: (next: string) => void;
  /** Cmd/Ctrl-S binding. Receives current value at the moment of save. */
  onSave?: (value: string) => void;
  /** Enable vim keybindings via monaco-vim. */
  vim?: boolean;
  /** Show in a "go to line" position once on mount. */
  initialLine?: number;
  /** Read-only mode (e.g. binary / >MAX_DIFF_BYTES). */
  readOnly?: boolean;
  /** When provided, connect this editor's model to the per-mission
   *  LSP (typescript-language-server inside the pod) so diagnostics,
   *  hover, completion and go-to-definition resolve against the
   *  real project graph. Pair must be set together. */
  missionId?: string;
  repoName?: string;
}

/**
 * Monaco editor wrapped for our needs:
 *  - Forgecart dark theme
 *  - Language detected from path
 *  - Optional vim mode (`monaco-vim`)
 *  - Cmd/Ctrl-S → onSave (Monaco's keybinding wins over the browser
 *    default, so we never trigger a page save dialog)
 *  - Optional initialLine: revealed + cursor placed there once on
 *    mount (used when project-wide search drills into a result)
 */
export function MonacoFileEditor({
  path,
  value,
  onChange,
  onSave,
  vim,
  initialLine,
  readOnly,
  missionId,
  repoName,
}: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const vimStatusRef = useRef<HTMLDivElement | null>(null);
  // monaco-vim's `initVimMode` is dynamically imported on the
  // client. The "disposer" object is kept here so we can clean up
  // before re-init or on unmount.
  const vimRef = useRef<{ dispose: () => void } | null>(null);
  // Stash the LSP client + URI captured at attach time so the
  // unmount cleanup can call closeModel without re-resolving the
  // pool (which would race with React's StrictMode double-mount).
  const lspAttachRef = useRef<{ client: LspClient; uri: string } | null>(null);

  const language = languageForPath(path);

  const onMount: OnMount = (ed, monaco: Monaco) => {
    ensureTheme(monaco);
    ensureTypeScriptDefaults(monaco);
    monaco.editor.setTheme("forgecart-dark");
    editorRef.current = ed;

    // Cmd/Ctrl-S → save. Monaco swallows the keybinding so the
    // browser doesn't intercept it as "Save Page As".
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const v = ed.getValue();
      onSave?.(v);
    });

    if (initialLine !== undefined) {
      ed.revealLineInCenter(initialLine);
      ed.setPosition({ lineNumber: initialLine, column: 1 });
      ed.focus();
    }

    // LSP attach. Skip if we don't have a mission+repo (e.g. a
    // standalone editor outside the Changes workspace).
    if (missionId && repoName) {
      const model = ed.getModel();
      if (model) {
        const uri = model.uri.toString();
        void getLspClient(missionId, repoName, monaco)
          .then((client: LspClient) => {
            lspAttachRef.current = { client, uri };
            client.openModel(model);
          })
          .catch((err: unknown) => {
            // LSP failure is non-fatal — the editor still works,
            // just without cross-file diagnostics.
            console.warn("LSP attach failed:", err);
          });
      }
    }
  };

  // Lazy-init / teardown of monaco-vim when the `vim` prop flips.
  useEffect(() => {
    let cancelled = false;
    const ed = editorRef.current;
    if (!ed) return;

    if (vim) {
      void import("monaco-vim").then((mod) => {
        if (cancelled) return;
        const init = (mod as { initVimMode: InitVimMode }).initVimMode;
        vimRef.current = init(ed, vimStatusRef.current ?? undefined);
      });
    } else if (vimRef.current) {
      vimRef.current.dispose();
      vimRef.current = null;
    }

    return () => {
      cancelled = true;
      // Don't dispose here on every effect re-run — only on unmount
      // (handled below). Effect-level dispose would tear down on
      // every render that includes a different `vim` value.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vim]);

  // Unmount cleanup for the vim adapter + LSP document.
  useEffect(() => {
    return () => {
      vimRef.current?.dispose();
      vimRef.current = null;
      const attach = lspAttachRef.current;
      if (attach) {
        try {
          attach.client.closeModel(attach.uri);
        } catch {
          // ignore — client may already be disposed
        }
        lspAttachRef.current = null;
      }
    };
  }, []);

  // When attached to an LSP we use the real workspace URI so the
  // server can resolve relative imports against the project graph.
  // Without LSP we fall back to the raw repo-relative path (the
  // original behaviour).
  const monacoPath =
    missionId && repoName ? modelUriFor(repoName, path) : path;

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0">
      <div className="flex-1 min-h-0">
        <Editor
          path={monacoPath}
          value={value}
          language={language}
          theme="forgecart-dark"
          onMount={onMount}
          onChange={(v) => onChange(v ?? "")}
          options={{
            readOnly,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily:
              '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
            wordWrap: "off",
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
            smoothScrolling: true,
            automaticLayout: true,
            // Bracket pair colorisation makes deeply-nested
            // configs (yaml, json) much more scannable.
            bracketPairColorization: { enabled: true },
            // Don't fight the user's tabs — show what's in the
            // file. Monaco still infers indent for new lines.
            detectIndentation: true,
          }}
        />
      </div>
      {vim && (
        <div
          ref={vimStatusRef}
          className="shrink-0 px-2 py-0.5 text-[11px] font-mono text-white/60 bg-black/40 border-t border-white/[0.06]"
        />
      )}
    </div>
  );
}

type InitVimMode = (
  editor: editor.IStandaloneCodeEditor,
  statusBar?: HTMLElement,
) => { dispose: () => void };
