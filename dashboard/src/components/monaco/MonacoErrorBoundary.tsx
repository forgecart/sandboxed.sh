"use client";

import { Component, type ReactNode } from "react";

/**
 * Wraps Monaco editor instances so their lifecycle errors don't
 * blow up the host tree. `@monaco-editor/react` + React 19 +
 * StrictMode have a known race during unmount where Monaco's
 * internal `dispose()` touches DOM nodes React has already
 * moved — `parent.removeChild(node)` ends up with `parent`
 * being null, the error propagates to the root, and because
 * the failing fiber stays in React's deletion queue, every
 * subsequent commit retries the same removal and crashes
 * again — the loop only ends when the page is reloaded.
 *
 * Catching the error here lets the rest of the mission view
 * keep working. The editor itself ends up unmounted (the boundary
 * renders its `fallback` while the error is sticky), but the
 * containing ChangesModal's `key={missionId}` will remount it
 * cleanly on the next mission switch / modal open.
 */
interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class MonacoErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // eslint-disable-next-line no-console
    console.warn(
      "[MonacoErrorBoundary] swallowed:",
      error.message,
      info.componentStack ?? "(no component stack)",
    );
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="flex h-full w-full items-center justify-center text-[12px] text-white/40">
            Editor unmounted unexpectedly. Reopen the file to retry.
          </div>
        )
      );
    }
    return this.props.children;
  }
}
