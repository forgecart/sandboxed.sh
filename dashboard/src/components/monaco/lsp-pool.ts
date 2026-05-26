"use client";

import type * as Monaco from "monaco-editor";
import { authHeader } from "@/lib/auth";
import { getRuntimeApiBase } from "@/lib/settings";
import { createLspClient, type LspClient } from "./lsp-client";

/**
 * One LSP WebSocket per (mission, repo). Mounting a second editor
 * tab on the same repo reuses the already-open client so the
 * server's project graph stays warm across files.
 *
 * Clients persist for the page lifetime. We don't proactively
 * dispose — closing the last tab in a repo could mean the user
 * is about to open another, and the LSP startup hit (TS resolves
 * the whole project on init) is the expensive thing we want to
 * pay only once per session.
 */
const clients = new Map<string, Promise<LspClient>>();

export function getLspClient(
  missionId: string,
  repoName: string,
  monaco: typeof Monaco,
): Promise<LspClient> {
  const key = `${missionId}:${repoName}`;
  const cached = clients.get(key);
  if (cached) return cached;

  const apiBase = getRuntimeApiBase();
  // Convert https://… → wss://…   (or http→ws for local dev).
  const wsUrl = apiBase.replace(/^http(s?):/, (_, s) => `ws${s}:`) +
    `/api/control/missions/${missionId}/lsp`;
  const rootUri = `file:///workspaces/repos/${repoName}`;

  const p = createLspClient({
    wsUrl,
    rootUri,
    monaco,
    authHeader: authHeader(),
  }).catch((e) => {
    // Drop the failed promise so the next caller retries.
    clients.delete(key);
    throw e;
  });
  clients.set(key, p);
  return p;
}

/**
 * Build the Monaco model URI for a file inside a repo. Must
 * match the rootUri scheme used by `getLspClient` so the LSP
 * recognises documents we open.
 */
export function modelUriFor(
  repoName: string,
  filePath: string,
): string {
  return `file:///workspaces/repos/${repoName}/${filePath}`;
}
