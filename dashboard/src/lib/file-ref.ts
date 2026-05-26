"use client";

/**
 * Parse / linkify `repo/path:line` style file references in chat
 * output.
 *
 * Format we ask the agent to emit (via CLAUDE.md inject, see
 * src/api/mission_runner.rs::inject_dashboard_file_refs_into_claude_md):
 *   - `<repo>/<path>/<to>/<file>.<ext>`
 *   - `<repo>/<path>/<to>/<file>.<ext>:<line>`
 *   - `<repo>/<path>/<to>/<file>.<ext>:<line>:<col>`
 *
 * Conservative regex to avoid false-positive matches on URLs,
 * dotted package names, etc.:
 *   - 2+ path segments separated by `/`
 *   - Last segment carries an extension from a whitelist (or is
 *     a known-name like `Dockerfile` / `Makefile`)
 *   - Optional `:N[:N]` suffix
 *
 * The whitelist keeps prose like `src/foo.txt` from triggering
 * on `foo.txt` alone (single segment), and trims the long tail
 * of obscure extensions that more often than not are false hits.
 */

export interface FileRef {
  /** First segment of the captured path — the repo. */
  repo: string;
  /** Repo-relative path with `/` separators. */
  path: string;
  /** 1-based line, if the ref carried `:N`. */
  line?: number;
  /** 1-based column, if the ref carried `:N:N`. */
  column?: number;
  /** Index in the source string where the match starts. */
  start: number;
  /** Index where the match ends. */
  end: number;
  /** Raw matched text (for replacement). */
  raw: string;
}

// Common code / config file extensions we consider safe to link.
// Curated short list to keep false-positive rate near zero on
// English prose. New extensions can be added freely.
const EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "rb",
  "php",
  "java",
  "kt",
  "kts",
  "swift",
  "cs",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "hxx",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "md",
  "mdx",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "sql",
  "graphql",
  "gql",
  "xml",
  "svg",
  "proto",
  "lock",
  "vue",
  "svelte",
  "astro",
  "txt",
  "conf",
]);

// Bare filenames that count as files even without an extension.
const BARE_FILENAMES = new Set([
  "Dockerfile",
  "Makefile",
  "GNUmakefile",
  "Caddyfile",
  "Procfile",
  "Justfile",
  "Brewfile",
  "Gemfile",
  "Rakefile",
  "CMakeLists.txt",
]);

// Capture group structure:
//  1: full path (e.g. "repo/src/foo.ts")
//  2: optional line (digits)
//  3: optional column (digits)
//
// Constraints:
//  - 2+ slash-separated segments (`a/b…`)
//  - Final segment carries an extension OR is a bare filename
//  - Surrounded by either word boundaries or whitespace/punct
const FILE_REF_REGEX =
  /(?<![A-Za-z0-9_/])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,})(?::(\d+)(?::(\d+))?)?(?![A-Za-z0-9_/])/g;

function isValidPath(p: string): boolean {
  // Reject if the whole thing is a URL component (contains `://`
  // anywhere left of us). The lookbehind already blocks `/foo`
  // chains; this catches the rare bare URL.
  if (p.includes("://")) return false;
  // Reject `//` runs.
  if (p.includes("//")) return false;
  // Reject if the path crosses what looks like a domain (e.g.
  // `example.com/page` — `example.com` contains a TLD-ish dot
  // but no extension at the end).
  const last = p.split("/").pop() ?? "";
  if (last === "") return false;
  if (BARE_FILENAMES.has(last)) return true;
  // Has at least one `.` and the final dot-suffix is in the
  // extension whitelist.
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return false; // hidden files like `.env` only allowed if alone, handled below
  const ext = last.slice(dot + 1).toLowerCase();
  if (!EXTENSIONS.has(ext)) return false;
  return true;
}

export function parseFileRef(text: string): FileRef | null {
  // Tighten the regex to anchor at start+end for single-token use.
  const m = text.match(
    /^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,})(?::(\d+)(?::(\d+))?)?$/,
  );
  if (!m) return null;
  const fullPath = m[1];
  if (!isValidPath(fullPath)) return null;
  const slash = fullPath.indexOf("/");
  const repo = fullPath.slice(0, slash);
  const path = fullPath.slice(slash + 1);
  return {
    repo,
    path,
    line: m[2] ? parseInt(m[2], 10) : undefined,
    column: m[3] ? parseInt(m[3], 10) : undefined,
    start: 0,
    end: text.length,
    raw: text,
  };
}

/**
 * Walk `text` for every plausible file reference. Each match is
 * returned with its byte range so the caller can splice React
 * children around it.
 */
export function findFileRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  // Reset lastIndex because the regex is /g.
  FILE_REF_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_REF_REGEX.exec(text)) !== null) {
    const full = m[1];
    if (!isValidPath(full)) continue;
    const slash = full.indexOf("/");
    out.push({
      repo: full.slice(0, slash),
      path: full.slice(slash + 1),
      line: m[2] ? parseInt(m[2], 10) : undefined,
      column: m[3] ? parseInt(m[3], 10) : undefined,
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
    });
  }
  return out;
}
