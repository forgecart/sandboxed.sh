import type { NextConfig } from "next";
import { readFileSync } from "fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8"));

const nextConfig: NextConfig = {
  ...(process.env.STANDALONE === "true" ? { output: "standalone" as const } : {}),
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  // StrictMode previously surfaced a recurring "Cannot read
  // properties of null (reading 'removeChild')" loop on mission
  // switch — caused by mission-bound state surviving across
  // missionId changes (Monaco editor instances, Zustand items
  // store, SSE handler refs all carrying through). Phase 0 of the
  // state-isolation refactor introduced `<MissionScope key={missionId}>`
  // around the mission-scoped subtree (mission-scope.tsx), and a
  // companion reset useEffect wipes parent-level state slices on
  // switch (control-client.tsx:6584). With both in place,
  // StrictMode's double-render no longer races — the mission
  // teardown is now idempotent. Re-enable for early detection of
  // future cleanup races.
  reactStrictMode: true,
  // Ship source maps to the browser in production. Without this,
  // every error in DevTools surfaces as a one-line trace through
  // `_next/static/chunks/abc123.js:1:9876` — useless for
  // debugging. With this, the browser remaps back to the
  // original component file / line on the fly. The `.map` files
  // are only fetched when DevTools is open, so end-user impact
  // is the disk space of the build artifact (~30% bigger) and
  // a slight bandwidth hit when the user has DevTools open.
  productionBrowserSourceMaps: true,
  turbopack: {
    root: process.cwd(),
  },
  // Barrel-file aware tree-shaking. Without this Next has to pull the whole
  // package for a single named import in a handful of files — even though
  // the runtime doesn't use it, the initial JS bundle carries it. `lucide-
  // react` is 45 MB on disk; `react-syntax-highlighter` is 9 MB and ships
  // the full Prism language set by default. Listing them here tells Next to
  // rewrite named imports into direct deep imports at compile time.
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "react-syntax-highlighter",
      "framer-motion",
    ],
  },
};

export default nextConfig;
