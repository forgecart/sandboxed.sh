"use client";

/**
 * Single multiplexed WebSocket to the per-mission workspace
 * stream. Verbs (list_dir, read_file, write_file, list_changes,
 * search, subscribe_fs) all ride on the same connection, with
 * server messages correlated to client requests by `id`.
 *
 * Why: every workspace operation hits the same kubectl-exec
 * plumbing; running them as independent HTTPS GETs paid the
 * TLS + auth handshake on each call and offered no streaming
 * path. Streaming matters most for `list_changes` (real progress
 * + progressive tree population) and `search` (results trickle
 * in, can be cancelled mid-flight).
 *
 * One client per mission. Constructor opens the WS lazily on
 * first request. Auto-reconnects with exponential backoff on
 * unexpected close; in-flight requests resolve as errors on
 * that disconnect (clients should retry).
 */

import { authHeader } from "@/lib/auth";
import { getRuntimeApiBase } from "@/lib/settings";

interface ServerEnvelope {
  id?: string;
  type:
    | "ready"
    | "chunk"
    | "progress"
    | "done"
    | "error"
    | "fs_change";
  data?: unknown;
  error?: string;
}

interface StreamHandler {
  onReady?: (data: unknown) => void;
  onChunk?: (data: unknown) => void;
  onProgress?: (p: { loaded: number; total: number }) => void;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

export interface WorkspaceStreamProgress {
  loaded: number;
  total: number;
}

export interface ListChangesReady {
  repos: Array<{
    name: string;
    files: Array<{ path: string; status: string }>;
  }>;
  total: number;
}

export interface ChangedFileChunk {
  file: {
    repo: string;
    path: string;
    status: string;
    head_content: string | null;
    worktree_content: string | null;
    truncated: boolean;
  };
}

/**
 * Server batches hits to ~25 per chunk (or every ~50ms) to keep
 * the WS frame count + React re-render count under control on
 * dense matches. Legacy `hit` shape kept around because older
 * builds emit it as a single-hit chunk.
 */
export interface SearchHitChunk {
  hits?: Array<{ file: string; line: number; snippet: string }>;
  hit?: { file: string; line: number; snippet: string };
}

export interface FsChangeEvent {
  repo: string;
  path: string;
  event: string;
}

type FsListener = (e: FsChangeEvent) => void;

let nextId = 0;
function genId(): string {
  nextId = (nextId + 1) | 0;
  return `r${Date.now().toString(36)}${nextId.toString(36)}`;
}

export class WorkspaceStream {
  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private handlers = new Map<string, StreamHandler>();
  private fsListeners = new Set<FsListener>();
  private fsSubId: string | null = null;
  private closed = false;
  private backoff = 1000;
  private connectAttempts = 0;

  constructor(private missionId: string) {}

  /** Single-response verb. Resolves with `done.data`, rejects on `error`. */
  call<T>(type: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.startRequest<T>(type, params, {}).result;
  }

  /**
   * Streaming verb. The returned `result` resolves when the
   * server sends `done`. `onChunk` fires per emitted chunk;
   * `onReady` once with the initial payload (used by
   * `list_changes` to surface the file list before per-file
   * content lands). `onProgress` for the real loaded/total
   * counter. `cancel` aborts the request server-side.
   */
  stream<TDone, TChunk = unknown, TReady = unknown>(
    type: string,
    params: Record<string, unknown>,
    handlers: {
      onReady?: (data: TReady) => void;
      onChunk?: (data: TChunk) => void;
      onProgress?: (p: WorkspaceStreamProgress) => void;
    } = {},
  ): { result: Promise<TDone>; cancel: () => void; id: string } {
    const req = this.startRequest<TDone>(type, params, handlers as StreamHandler);
    const cancel = () => {
      void this.sendRaw({ type: "cancel", params: { request_id: req.id } });
    };
    return { result: req.result, cancel, id: req.id };
  }

  /**
   * Subscribe to pod-side file-system changes. First call opens
   * the long-lived subscribe_fs request on the server; subsequent
   * calls just attach more listeners. Returns an unsubscribe fn.
   */
  subscribeFsChanges(listener: FsListener): () => void {
    this.fsListeners.add(listener);
    if (!this.fsSubId) {
      // Long-lived stream — we don't await `done`; the listener
      // fires on each `fs_change` event.
      this.fsSubId = genId();
      void this.ensureOpen().then(() => {
        this.sendRaw({ id: this.fsSubId!, type: "subscribe_fs", params: {} });
      });
    }
    return () => {
      this.fsListeners.delete(listener);
      // If no one's listening anymore, cancel the subscription.
      if (this.fsListeners.size === 0 && this.fsSubId) {
        const id = this.fsSubId;
        this.fsSubId = null;
        void this.sendRaw({ type: "cancel", params: { request_id: id } });
      }
    };
  }

  dispose() {
    this.closed = true;
    this.handlers.forEach((h) =>
      h.reject(new Error("WorkspaceStream disposed")),
    );
    this.handlers.clear();
    this.fsListeners.clear();
    this.fsSubId = null;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  // ── internals ────────────────────────────────────────────

  private startRequest<T>(
    type: string,
    params: Record<string, unknown>,
    handlers: Omit<StreamHandler, "resolve" | "reject">,
  ): { id: string; result: Promise<T> } {
    const id = genId();
    const result = new Promise<T>((resolve, reject) => {
      this.handlers.set(id, {
        ...handlers,
        resolve: (data) => resolve(data as T),
        reject,
      });
      void this.sendRaw({ id, type, params });
    });
    return { id, result };
  }

  private async sendRaw(payload: unknown): Promise<void> {
    await this.ensureOpen();
    try {
      this.ws!.send(JSON.stringify(payload));
    } catch (e) {
      // Surface as a per-handler error for the matching id, if any.
      const id = (payload as { id?: string }).id;
      if (id) {
        const h = this.handlers.get(id);
        if (h) {
          this.handlers.delete(id);
          h.reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    }
  }

  private ensureOpen(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("disposed"));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;

    this.opening = new Promise<void>((resolve, reject) => {
      const apiBase = getRuntimeApiBase();
      const wsUrl =
        apiBase.replace(/^http(s?):/, (_, s) => `ws${s}:`) +
        `/api/control/missions/${this.missionId}/workspace-stream`;
      const tok = (authHeader().Authorization ?? "").replace(/^Bearer\s+/i, "");
      const url = tok ? `${wsUrl}?token=${encodeURIComponent(tok)}` : wsUrl;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.connectAttempts = 0;
        this.backoff = 1000;
        this.opening = null;
        // Re-subscribe fs after reconnect.
        if (this.fsListeners.size > 0 && !this.fsSubId) {
          this.fsSubId = genId();
          ws.send(
            JSON.stringify({
              id: this.fsSubId,
              type: "subscribe_fs",
              params: {},
            }),
          );
        }
        resolve();
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onerror = () => {
        // Resolved or rejected by onclose.
      };
      ws.onclose = () => {
        const wasOpening = this.opening !== null;
        this.opening = null;
        this.ws = null;
        // Reject all pending request handlers on disconnect.
        // Long-lived subs are restored when ensureOpen is called
        // again (which happens on the next sendRaw).
        if (this.fsSubId) {
          this.fsSubId = null; // re-establish on next open
        }
        for (const [id, h] of this.handlers) {
          h.reject(new Error("WorkspaceStream disconnected"));
          this.handlers.delete(id);
        }
        if (wasOpening) {
          reject(new Error("WorkspaceStream failed to open"));
        }
        if (!this.closed) {
          this.connectAttempts += 1;
          const delay = Math.min(30_000, this.backoff);
          this.backoff = this.backoff * 2;
          window.setTimeout(() => {
            if (!this.closed && this.handlers.size === 0 && this.fsListeners.size === 0) {
              // Nothing to do; stay closed until next request.
              return;
            }
            void this.ensureOpen();
          }, delay);
        }
      };
    });
    return this.opening;
  }

  private onMessage(raw: unknown) {
    if (typeof raw !== "string") return;
    let msg: ServerEnvelope;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "fs_change") {
      const data = msg.data as FsChangeEvent;
      for (const l of this.fsListeners) {
        try {
          l(data);
        } catch (e) {
          console.warn("fs listener error", e);
        }
      }
      return;
    }
    const id = msg.id ?? "";
    const h = this.handlers.get(id);
    if (!h) return;
    switch (msg.type) {
      case "ready":
        h.onReady?.(msg.data);
        break;
      case "chunk":
        h.onChunk?.(msg.data);
        break;
      case "progress": {
        const p = msg.data as WorkspaceStreamProgress;
        h.onProgress?.(p);
        break;
      }
      case "done":
        this.handlers.delete(id);
        h.resolve(msg.data);
        break;
      case "error":
        this.handlers.delete(id);
        h.reject(new Error(msg.error || "stream error"));
        break;
    }
  }
}

// ── singleton pool ─────────────────────────────────────────

const pool = new Map<string, WorkspaceStream>();

export function getWorkspaceStream(missionId: string): WorkspaceStream {
  let s = pool.get(missionId);
  if (!s) {
    s = new WorkspaceStream(missionId);
    pool.set(missionId, s);
  }
  return s;
}

export function disposeWorkspaceStream(missionId: string) {
  const s = pool.get(missionId);
  if (s) {
    s.dispose();
    pool.delete(missionId);
  }
}
