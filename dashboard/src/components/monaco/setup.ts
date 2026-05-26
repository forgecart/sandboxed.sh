"use client";

import type { Monaco } from "@monaco-editor/react";
import { emitFileRef } from "@/lib/file-ref-bus";

/**
 * Monaco setup helpers shared by the diff viewer and the file
 * editor. Keep `import("monaco-editor")` out of module scope so
 * Next.js's server bundle never tries to load it (it's
 * browser-only).
 */

/**
 * Map a file extension (or shebang-driven hint) to a Monaco
 * language id. Monaco ships a long list of built-in languages;
 * unrecognised extensions fall back to `plaintext` rather than
 * throwing.
 */
export function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  // Filename special-cases — checked before extension so
  // `Dockerfile` (no extension) still maps correctly.
  const base = lower.split("/").pop() ?? "";
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  if (base.endsWith(".gitignore") || base.endsWith(".gitattributes")) return "plaintext";

  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    php: "php",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    cs: "csharp",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    hxx: "cpp",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    json: "json",
    jsonc: "jsonc",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    ini: "ini",
    md: "markdown",
    mdx: "markdown",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    sql: "sql",
    graphql: "graphql",
    gql: "graphql",
    xml: "xml",
    svg: "xml",
    proto: "protobuf",
  };
  return map[ext] ?? "plaintext";
}

/**
 * Configure Monaco's bundled TypeScript / JavaScript language
 * services for our single-file editing mode.
 *
 * The default TS service ships with classic module resolution
 * and treats every open file as an isolated compilation unit —
 * so importing a sibling file produces "Cannot find module
 * './foo'" (TS2792). Since we don't load the user's whole
 * project into Monaco's model graph, *semantic* diagnostics are
 * just noise: every relative import would light up red.
 *
 * Solution: disable semantic diagnostics (no module resolution
 * errors, no missing-type errors) but keep syntactic diagnostics
 * (real parse errors stay visible). Also set NodeNext-style
 * compiler options so the language service at least understands
 * the syntax it's parsing (JSX, modern target).
 *
 * Idempotent — re-running on every editor mount is fine.
 */
export function ensureTypeScriptDefaults(monaco: Monaco) {
  const targets = [
    monaco.languages.typescript.typescriptDefaults,
    monaco.languages.typescript.javascriptDefaults,
  ];
  for (const def of targets) {
    def.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: true,
    });
    def.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution:
        monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      allowNonTsExtensions: true,
      allowJs: true,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      skipLibCheck: true,
      // Keep `import type` working even though we have no real
      // resolution.
      isolatedModules: true,
    });
    def.setEagerModelSync(true);
  }
}

/**
 * Register a Monaco editor opener that routes cross-file
 * navigations (Cmd-click on an identifier, right-click → Go to
 * Definition, etc.) through our tab system.
 *
 * Monaco's standalone build has NO default opener — when the
 * editor needs to navigate to a URI it doesn't already host as
 * a model, it silently no-ops. So Cmd-click on a symbol defined
 * in another file would fire the LSP `textDocument/definition`,
 * get back a `file:///workspaces/repos/<repo>/<path>` Location,
 * then fail to navigate.
 *
 * Our opener parses that URI and dispatches to the file-ref bus,
 * which the dashboard already wires up to open a new edit tab at
 * the target line.
 *
 * `openCodeEditor` returns `true` to tell Monaco "I handled it"
 * so it doesn't try its own (no-op) navigation afterward.
 *
 * Idempotent — Monaco caches openers internally; re-registering
 * the same handler is harmless.
 */
let openerRegistered = false;
export function ensureEditorOpener(monaco: Monaco) {
  if (openerRegistered) return;
  openerRegistered = true;
  // The `IEditorOpener` shape isn't exported from the
  // @monaco-editor/react public types, so cast at the boundary
  // and accept the loose signature internally.
  type UriLike = { toString(): string };
  type RangeLike = { startLineNumber?: number };
  type PositionLike = { lineNumber?: number };
  const opener = {
    openCodeEditor(
      _source: unknown,
      resource: UriLike,
      selectionOrPosition?: RangeLike | PositionLike | null,
    ): boolean {
      const uri = resource.toString();
      const m = uri.match(
        /^file:\/\/\/workspaces\/repos\/([^/]+)\/(.+?)(?:#.*)?$/,
      );
      if (!m) return false;
      const [, repo, path] = m;
      let line: number | undefined;
      if (selectionOrPosition) {
        if ("startLineNumber" in selectionOrPosition) {
          line = (selectionOrPosition as RangeLike).startLineNumber;
        } else if ("lineNumber" in selectionOrPosition) {
          line = (selectionOrPosition as PositionLike).lineNumber;
        }
      }
      emitFileRef({ repo, path, line });
      return true;
    },
  };
  (
    monaco.editor as unknown as {
      registerEditorOpener: (o: typeof opener) => unknown;
    }
  ).registerEditorOpener(opener);
}

/**
 * Register our dark theme on the Monaco instance once. We mirror
 * the rest of the dashboard's palette (indigo accent, near-black
 * background) rather than using `vs-dark` so the editor doesn't
 * stand out from the surrounding modal.
 */
export function ensureTheme(monaco: Monaco) {
  monaco.editor.defineTheme("forgecart-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b7280", fontStyle: "italic" },
      { token: "string", foreground: "a78bfa" },
      { token: "number", foreground: "fbbf24" },
      { token: "keyword", foreground: "818cf8" },
      { token: "type", foreground: "34d399" },
    ],
    colors: {
      "editor.background": "#0d0d0d",
      "editor.foreground": "#e5e7eb",
      "editorLineNumber.foreground": "#3f3f46",
      "editorLineNumber.activeForeground": "#a5b4fc",
      "editor.selectionBackground": "#312e8155",
      "editor.lineHighlightBackground": "#18181b",
      "editorCursor.foreground": "#a5b4fc",
      "editorWhitespace.foreground": "#27272a",
      "editorIndentGuide.background1": "#1f1f23",
      "diffEditor.insertedTextBackground": "#10b98122",
      "diffEditor.removedTextBackground": "#ef444422",
    },
  });
}
