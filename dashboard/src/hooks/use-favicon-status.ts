"use client";

import { useEffect, useRef } from "react";
import type { MissionStatus } from "@/lib/api/missions";

/**
 * Hex colors matching the mission status dot palette used in the UI.
 */
const STATUS_COLORS: Record<MissionStatus, string> = {
  pending: "#fbbf24", // amber-400
  active: "#818cf8", // indigo-400
  awaiting_user: "#38bdf8", // sky-400
  acknowledged: "#34d399", // emerald-400
  completed: "#34d399", // emerald-400
  // Failure statuses all share `bg-red-400` in `STATUS_DOT_COLORS`
  // (`lib/mission-status.ts`); the favicon dot now matches so the
  // status indicator is consistent across the UI.
  failed: "#f87171", // red-400
  interrupted: "#f87171", // red-400
  blocked: "#f87171", // red-400
  not_feasible: "#f87171", // red-400
};

/** Dot radius & position (on a 64×64 canvas). */
const DOT_RADIUS = 10;
const DOT_X = 52;
const DOT_Y = 52;

/** Always use the SVG source as the base image for canvas drawing. */
const BASE_FAVICON = "/favicon.svg";

/** Data attribute to identify our managed link element. */
const DATA_ATTR = "data-favicon-status";

/**
 * Dynamically overlays a coloured status dot on the favicon.
 *
 * Appends its own `<link rel="icon">` element to document.head. Browsers
 * (Chrome, Firefox, Safari, Edge) pick the last `<link rel="icon">` in
 * head, so our managed link takes precedence over Next.js's static
 * favicon without touching any Next.js-owned DOM nodes.
 *
 * Earlier versions of this hook removed the Next.js-managed favicon
 * links from document.head and stored them in a ref to re-append on
 * unmount. That created a React 19 commit-phase race: when the
 * component unmounted, React's deletion fiber tried to removeChild on
 * the detached Next.js `<link>` (whose parentNode was now null),
 * throwing `Cannot read properties of null (reading 'removeChild')`
 * and putting React's commit queue into a retry loop. The fix here is
 * "append-only" — we never detach a node we don't own.
 */
export function useFaviconStatus(status: MissionStatus | null, isRunning: boolean) {
  const cachedImg = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    // No active mission → remove our managed link and stop. Next.js's
    // own favicon links remain in place and reassert themselves.
    if (!status) {
      document.querySelector(`link[${DATA_ATTR}]`)?.remove();
      return;
    }

    const color = isRunning ? "#818cf8" : STATUS_COLORS[status];

    const applyFavicon = (img: HTMLImageElement) => {
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(img, 0, 0, size, size);

      // Dark border matching favicon background
      ctx.beginPath();
      ctx.arc(DOT_X, DOT_Y, DOT_RADIUS + 2, 0, Math.PI * 2);
      ctx.fillStyle = "#121214";
      ctx.fill();

      // Colored status dot
      ctx.beginPath();
      ctx.arc(DOT_X, DOT_Y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      const dataUrl = canvas.toDataURL("image/png");

      // Create or update our managed link. We never remove
      // Next.js-managed favicon links — appending ours last is
      // enough; the browser uses the last <link rel="icon">.
      let managed = document.querySelector<HTMLLinkElement>(`link[${DATA_ATTR}]`);
      if (!managed) {
        managed = document.createElement("link");
        managed.rel = "icon";
        managed.setAttribute(DATA_ATTR, "true");
      }
      managed.type = "image/png";
      managed.href = dataUrl;
      // Always append (or re-append) last so we win the
      // "last-link-wins" tiebreak. appendChild is a no-op if the
      // node is already the last child.
      document.head.appendChild(managed);
    };

    let cancelled = false;

    const apply = () => {
      if (cancelled) return;
      if (cachedImg.current) {
        applyFavicon(cachedImg.current);
      } else {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = BASE_FAVICON;
        img.onload = () => {
          if (cancelled) return;
          cachedImg.current = img;
          applyFavicon(img);
        };
      }
    };

    apply();

    // Re-apply when tab becomes visible (Chrome tab restore, wake from sleep, etc.)
    const onVisibility = () => {
      if (document.visibilityState === "visible") apply();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [status, isRunning]);

  // Cleanup on full unmount: remove our managed link only. Never touch
  // Next.js-owned <link> elements — letting React's commit phase delete
  // them is what the static head is for.
  useEffect(() => {
    return () => {
      document.querySelector(`link[${DATA_ATTR}]`)?.remove();
    };
  }, []);
}
