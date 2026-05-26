"use client";

/**
 * Minimal LSP client wired to Monaco.
 *
 * We deliberately do NOT use `monaco-languageclient` v10 — it
 * requires the full `@codingame/monaco-vscode-api` service stack
 * (workbench, configuration, theme, etc.) which fights Next.js's
 * App-Router bundling hard (web workers, ESM/CJS interop quirks,
 * worker URL discovery). For our scope (TS / JS diagnostics,
 * hover, completion, definition) the LSP wire protocol is small
 * enough to map directly against Monaco's existing extension
 * APIs.
 *
 * Wire:
 *   WebSocket  <—vscode-ws-jsonrpc—>  vscode-jsonrpc connection
 *                                           |
 *                                           v
 *                                 LSP requests + notifications
 *                                           |
 *                                           v
 *                                 monaco.languages.register*Provider
 *                                 monaco.editor.setModelMarkers
 *
 * One client per (mission, repo). All editor tabs sharing that
 * repo open documents on the same client so the server's
 * cross-file analysis sees the whole workspace.
 */

import type * as Monaco from "monaco-editor";
import {
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/browser";
import {
  toSocket,
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from "vscode-ws-jsonrpc";
import type {
  CompletionItem as LspCompletionItem,
  Diagnostic as LspDiagnostic,
  Hover as LspHover,
  InitializeResult,
  Location as LspLocation,
  PublishDiagnosticsParams,
  Range as LspRange,
  TextDocumentPositionParams,
} from "vscode-languageserver-protocol";

export interface LspClient {
  /** Register a Monaco model with the server (sends textDocument/didOpen). */
  openModel: (model: Monaco.editor.ITextModel) => void;
  /** Unregister a model (sends textDocument/didClose). */
  closeModel: (uri: string) => void;
  /** Tear down the WebSocket + remove Monaco provider registrations. */
  dispose: () => void;
}

interface LspClientOptions {
  /** `wss://.../api/control/missions/:id/lsp` */
  wsUrl: string;
  /** Workspace root URI — e.g. `file:///workspaces/repos/<repo>`. */
  rootUri: string;
  /** Monaco namespace (passed in so we don't drag a static import of
   *  the browser-only module into the server bundle). */
  monaco: typeof Monaco;
  /** Auth header — same Bearer token everything else uses. */
  authHeader?: Record<string, string>;
}

/**
 * Build a fresh LSP client, open the WebSocket, run the
 * `initialize` handshake, and wire Monaco providers. Resolves
 * after `initialized` is sent. Rejects if the WS errors during
 * setup.
 */
export async function createLspClient(opts: LspClientOptions): Promise<LspClient> {
  const { wsUrl, rootUri, monaco } = opts;

  // WebSocket doesn't accept custom headers in the browser; the
  // Bearer token has to ride in the URL. The control-plane LSP
  // route already accepts the standard cookie/Authorization, but
  // for portability we tack ?token=... onto the URL — the route
  // is auth-extension'd so either path works.
  const url = new URL(wsUrl);
  if (opts.authHeader?.["Authorization"]) {
    const tok = opts.authHeader["Authorization"].replace(/^Bearer\s+/i, "");
    url.searchParams.set("token", tok);
  }
  const ws = new WebSocket(url.toString());

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("LSP WebSocket failed to open")),
      { once: true },
    );
  });

  const socket = toSocket(ws);
  const reader = new WebSocketMessageReader(socket);
  const writer = new WebSocketMessageWriter(socket);
  const connection: MessageConnection = createMessageConnection(reader, writer);
  connection.listen();

  // Track each model we've opened so we send didChange against the
  // right URI + version, and so dispose can close them all.
  const openModels = new Map<string, { model: Monaco.editor.ITextModel; version: number; sub: Monaco.IDisposable }>();
  const providerDisposables: Monaco.IDisposable[] = [];

  // Diagnostics → setModelMarkers. The LSP can publish for any
  // open URI, including transitive imports the user never clicked
  // — we set markers on whichever model we have at that URI.
  connection.onNotification(
    "textDocument/publishDiagnostics",
    (params: PublishDiagnosticsParams) => {
      const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
      if (!model) return;
      monaco.editor.setModelMarkers(
        model,
        "lsp",
        params.diagnostics.map((d) => lspDiagnosticToMonaco(monaco, d)),
      );
    },
  );

  // initialize → initialized.
  const initParams = {
    processId: null,
    rootUri,
    rootPath: rootUri.replace(/^file:\/\//, ""),
    workspaceFolders: [{ uri: rootUri, name: "root" }],
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false },
        completion: {
          completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] },
        },
        hover: { contentFormat: ["markdown", "plaintext"] },
        definition: { dynamicRegistration: false },
        publishDiagnostics: { relatedInformation: true },
      },
      workspace: {
        workspaceFolders: true,
      },
    },
  };
  const init = await connection.sendRequest<InitializeResult>(
    "initialize",
    initParams,
  );
  await connection.sendNotification("initialized", {});

  // Register Monaco providers for the languages TS LSP serves.
  // typescript-language-server handles ts, tsx, js, jsx by default.
  const languages = ["typescript", "javascript"];
  for (const lang of languages) {
    providerDisposables.push(
      monaco.languages.registerHoverProvider(lang, {
        async provideHover(model, position) {
          const uri = model.uri.toString();
          if (!openModels.has(uri)) return null;
          try {
            const hover = await connection.sendRequest<LspHover | null>(
              "textDocument/hover",
              positionParams(uri, position),
            );
            return hover ? lspHoverToMonaco(monaco, hover) : null;
          } catch {
            return null;
          }
        },
      }),
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: triggers(init),
        async provideCompletionItems(model, position) {
          const uri = model.uri.toString();
          if (!openModels.has(uri)) return { suggestions: [] };
          try {
            const items = await connection.sendRequest<
              LspCompletionItem[] | { items: LspCompletionItem[] } | null
            >("textDocument/completion", positionParams(uri, position));
            const list = Array.isArray(items)
              ? items
              : (items?.items ?? []);
            return {
              suggestions: list.map((it) =>
                lspCompletionItemToMonaco(monaco, it, model, position),
              ),
            };
          } catch {
            return { suggestions: [] };
          }
        },
      }),
      monaco.languages.registerDefinitionProvider(lang, {
        async provideDefinition(model, position) {
          const uri = model.uri.toString();
          if (!openModels.has(uri)) return null;
          try {
            const loc = await connection.sendRequest<
              LspLocation | LspLocation[] | null
            >("textDocument/definition", positionParams(uri, position));
            if (!loc) return null;
            const arr = Array.isArray(loc) ? loc : [loc];
            return arr.map((l) => ({
              uri: monaco.Uri.parse(l.uri),
              range: lspRangeToMonaco(l.range),
            }));
          } catch {
            return null;
          }
        },
      }),
    );
  }

  function openModel(model: Monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    if (openModels.has(uri)) return;
    const languageId = model.getLanguageId();
    void connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: model.getValue(),
      },
    });
    const sub = model.onDidChangeContent(() => {
      const entry = openModels.get(uri);
      if (!entry) return;
      entry.version += 1;
      void connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: entry.version },
        contentChanges: [{ text: model.getValue() }],
      });
    });
    openModels.set(uri, { model, version: 1, sub });
  }

  function closeModel(uri: string) {
    const entry = openModels.get(uri);
    if (!entry) return;
    entry.sub.dispose();
    openModels.delete(uri);
    void connection.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  function dispose() {
    for (const uri of Array.from(openModels.keys())) closeModel(uri);
    for (const d of providerDisposables) d.dispose();
    try {
      void connection.sendNotification("exit", undefined);
    } catch {
      // ignore — connection may already be closed
    }
    connection.dispose();
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  return { openModel, closeModel, dispose };
}

// ── conversion helpers ──────────────────────────────────────

function positionParams(
  uri: string,
  position: Monaco.Position,
): TextDocumentPositionParams {
  return {
    textDocument: { uri },
    position: { line: position.lineNumber - 1, character: position.column - 1 },
  };
}

function triggers(init: InitializeResult): string[] {
  const caps = init.capabilities;
  const c = caps.completionProvider;
  if (!c?.triggerCharacters) return [".", "'", '"', "`", "/", "@", "<"];
  return c.triggerCharacters;
}

function lspRangeToMonaco(range: LspRange): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function lspDiagnosticToMonaco(
  monaco: typeof Monaco,
  d: LspDiagnostic,
): Monaco.editor.IMarkerData {
  // LSP severity 1..4 ↔ Monaco MarkerSeverity 8/4/2/1
  const sev = (() => {
    switch (d.severity) {
      case 1:
        return monaco.MarkerSeverity.Error;
      case 2:
        return monaco.MarkerSeverity.Warning;
      case 3:
        return monaco.MarkerSeverity.Info;
      case 4:
        return monaco.MarkerSeverity.Hint;
      default:
        return monaco.MarkerSeverity.Info;
    }
  })();
  // LSP's `code` can be `string | number | { value, target }`.
  // Monaco wants a string (or its own `IMarkerCode` shape); flatten
  // both forms here.
  let code: string | undefined;
  const dc = d.code as unknown;
  if (typeof dc === "string" || typeof dc === "number") {
    code = String(dc);
  } else if (dc && typeof dc === "object" && "value" in dc) {
    code = String((dc as { value: string | number }).value);
  }
  return {
    severity: sev,
    message: d.message,
    source: d.source ?? "lsp",
    code,
    ...lspRangeToMonaco(d.range),
  };
}

function lspHoverToMonaco(
  monaco: typeof Monaco,
  h: LspHover,
): Monaco.languages.Hover {
  const contents: { value: string }[] = [];
  const push = (s: string | { language?: string; value?: string }) => {
    if (typeof s === "string") {
      contents.push({ value: s });
    } else if (s?.language) {
      contents.push({ value: "```" + s.language + "\n" + (s.value ?? "") + "\n```" });
    } else if (s?.value) {
      contents.push({ value: s.value });
    }
  };
  if (Array.isArray(h.contents)) {
    h.contents.forEach(push);
  } else if (typeof h.contents === "string") {
    push(h.contents);
  } else if ("kind" in h.contents) {
    contents.push({ value: h.contents.value });
  } else {
    push(h.contents as { language?: string; value?: string });
  }
  return {
    contents,
    range: h.range ? lspRangeToMonaco(h.range) : undefined,
  };
  // We're using the relaxed `monaco` shape since the Monaco type
  // lives in a `dynamic()` import — TS sees it as `typeof Monaco`.
  void monaco;
}

function lspCompletionItemToMonaco(
  monaco: typeof Monaco,
  it: LspCompletionItem,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.CompletionItem {
  // Default range = current word. LSP `textEdit` overrides if present.
  const word = model.getWordUntilPosition(position);
  const defaultRange: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  };
  let range: Monaco.IRange = defaultRange;
  const labelStr =
    typeof it.label === "string"
      ? it.label
      : (it.label as { label: string }).label;
  let insertText = it.insertText ?? labelStr;
  if (it.textEdit) {
    const te = it.textEdit as unknown as
      | { range: LspRange; newText: string }
      | { insert: LspRange; replace: LspRange; newText: string };
    if ("range" in te) {
      range = lspRangeToMonaco(te.range);
    } else if ("insert" in te) {
      range = lspRangeToMonaco(te.insert);
    }
    insertText = te.newText ?? insertText;
  }
  const kind = it.kind ?? 1;
  return {
    label: labelStr,
    kind: lspCompletionKindToMonaco(monaco, kind),
    insertText,
    insertTextRules:
      it.insertTextFormat === 2 // Snippet
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : monaco.languages.CompletionItemInsertTextRule.None,
    detail: it.detail,
    documentation:
      typeof it.documentation === "string"
        ? it.documentation
        : it.documentation?.value,
    range,
    sortText: it.sortText,
    filterText: it.filterText,
    preselect: it.preselect,
  };
}

function lspCompletionKindToMonaco(
  monaco: typeof Monaco,
  k: number,
): Monaco.languages.CompletionItemKind {
  // LSP kinds 1..25 map roughly to Monaco; pick the closest.
  const Kind = monaco.languages.CompletionItemKind;
  const map: Record<number, Monaco.languages.CompletionItemKind> = {
    1: Kind.Text,
    2: Kind.Method,
    3: Kind.Function,
    4: Kind.Constructor,
    5: Kind.Field,
    6: Kind.Variable,
    7: Kind.Class,
    8: Kind.Interface,
    9: Kind.Module,
    10: Kind.Property,
    11: Kind.Unit,
    12: Kind.Value,
    13: Kind.Enum,
    14: Kind.Keyword,
    15: Kind.Snippet,
    16: Kind.Color,
    17: Kind.File,
    18: Kind.Reference,
    19: Kind.Folder,
    20: Kind.EnumMember,
    21: Kind.Constant,
    22: Kind.Struct,
    23: Kind.Event,
    24: Kind.Operator,
    25: Kind.TypeParameter,
  };
  return map[k] ?? Kind.Text;
}
