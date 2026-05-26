"use client";

/**
 * Tiny event bus for "open this file in the editor at line N"
 * actions. The chat markdown linkifier dispatches; the Changes
 * panel listens (it owns the modal toggle + tab state).
 *
 * Why an ad-hoc bus instead of context: the chat lives deep in
 * the React tree, the modal is mounted at the root, and the
 * action is single-fire. A 30-line emitter is cheaper than a
 * context provider + memoised handler + ref forwarding through
 * MarkdownContent's memoised render path.
 */

export interface FileRefTarget {
  /** Repo directory name under `/workspaces/repos/`. */
  repo: string;
  /** Repo-relative path with `/` separators. */
  path: string;
  /** 1-based line, when known. */
  line?: number;
}

type Listener = (target: FileRefTarget) => void;
const listeners = new Set<Listener>();

export function emitFileRef(target: FileRefTarget) {
  for (const l of listeners) {
    try {
      l(target);
    } catch (e) {
      console.warn("file-ref listener error", e);
    }
  }
}

export function onFileRef(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
