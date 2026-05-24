/**
 * GitHub App client (dashboard side).
 *
 * Wraps `GET /api/github/repositories` — the backend mints a short-lived
 * installation token via the configured GitHub App and returns every repo
 * the installation can see. Used by the repo picker in the New Mission
 * dialog. A 404 from the endpoint means the App isn't configured, in which
 * case `listGithubRepositories` resolves to `null` so the caller can hide
 * the picker silently.
 */

import { apiFetch } from "./core";

export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  clone_url: string;
  private: boolean;
  description?: string | null;
}

export interface GithubAppStatus {
  enabled: boolean;
  app_id?: string;
  installation_id?: string;
}

/**
 * Returns the installation's repos, or `null` when the App isn't configured
 * (404). Other errors throw so the dialog can render a retry button.
 */
export async function listGithubRepositories(): Promise<GithubRepo[] | null> {
  const res = await apiFetch("/api/github/repositories");
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `Failed to list GitHub repositories (${res.status})`);
  }
  return res.json();
}

export async function getGithubAppStatus(): Promise<GithubAppStatus> {
  const res = await apiFetch("/api/github/status");
  if (!res.ok) {
    throw new Error(`Failed to fetch GitHub App status (${res.status})`);
  }
  return res.json();
}
