'use client';

import useSWR from 'swr';
import { ExternalLink, RefreshCw, ShieldAlert, ShieldCheck, Github } from 'lucide-react';
import {
  getGithubAppStatus,
  listGithubRepositories,
  type GithubAppStatus,
  type GithubRepo,
} from '@/lib/api';

const REQUIRED_PERMISSIONS: Array<{
  key: string;
  expected: 'read' | 'write';
  label: string;
  rationale: string;
}> = [
  {
    key: 'metadata',
    expected: 'read',
    label: 'Metadata',
    rationale: 'List repos the installation can see (repo picker dropdown).',
  },
  {
    key: 'contents',
    expected: 'read',
    label: 'Contents — Read',
    rationale: 'Clone picked repos into the mission workspace.',
  },
  {
    key: 'contents',
    expected: 'write',
    label: 'Contents — Write',
    rationale: 'Let agents `git push` to branches in the cloned repos.',
  },
  {
    key: 'pull_requests',
    expected: 'write',
    label: 'Pull requests — Write',
    rationale: 'Let agents open / comment on PRs via the `gh` CLI.',
  },
  {
    key: 'issues',
    expected: 'write',
    label: 'Issues — Write',
    rationale: 'Let agents create / comment on issues via the `gh` CLI.',
  },
];

function permissionStatus(
  perms: Record<string, string> | undefined,
  key: string,
  expected: 'read' | 'write',
): 'ok' | 'partial' | 'missing' {
  if (!perms) return 'missing';
  const have = perms[key];
  if (!have) return 'missing';
  if (have === expected) return 'ok';
  // read+write granted satisfies a "read" requirement; "read" doesn't satisfy "write".
  if (expected === 'read' && (have === 'read' || have === 'write')) return 'ok';
  if (expected === 'write' && have === 'write') return 'ok';
  return 'partial';
}

export default function GithubSettingsPage() {
  const {
    data: status,
    error: statusError,
    isLoading: statusLoading,
    mutate: refreshStatus,
  } = useSWR<GithubAppStatus>('github-app-status', getGithubAppStatus, {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
  });

  const {
    data: repos,
    error: reposError,
    isLoading: reposLoading,
    mutate: refreshRepos,
  } = useSWR<GithubRepo[] | null>(
    status?.enabled ? 'github-repositories' : null,
    listGithubRepositories,
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  const accountLogin = status?.account_login ?? 'forgecart';
  const installationId = status?.installation_id;
  const appId = status?.app_id;
  const permissionsUrl = `https://github.com/organizations/${accountLogin}/settings/apps/forgecart-deployment/permissions`;
  const installationUrl = installationId
    ? `https://github.com/organizations/${accountLogin}/settings/installations/${installationId}`
    : `https://github.com/organizations/${accountLogin}/settings/installations`;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <Github className="h-6 w-6 text-white/60 mt-0.5" />
            <div>
              <h1 className="text-xl font-semibold text-white">GitHub App</h1>
              <p className="text-sm text-white/50 mt-1">
                Repo picker on mission creation + auto-clone into the workspace.
                Configured via <code className="text-xs bg-white/[0.06] px-1 py-0.5 rounded">GITHUB_APP_ID</code>,{' '}
                <code className="text-xs bg-white/[0.06] px-1 py-0.5 rounded">GITHUB_APP_INSTALLATION_ID</code>, and{' '}
                <code className="text-xs bg-white/[0.06] px-1 py-0.5 rounded">GITHUB_APP_PRIVATE_KEY</code> env vars.
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              refreshStatus();
              refreshRepos();
            }}
            className="p-2 rounded-md text-white/40 hover:text-white/70 hover:bg-white/[0.04] transition-colors"
            title="Refresh"
          >
            <RefreshCw
              className={`h-4 w-4 ${statusLoading || reposLoading ? 'animate-spin' : ''}`}
            />
          </button>
        </header>

        {statusError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
            Failed to fetch GitHub App status: {String(statusError)}
          </div>
        )}

        {/* Connection card */}
        <section className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-5">
          <h2 className="text-sm font-medium text-white mb-3">Connection</h2>
          {!status?.enabled ? (
            <div className="text-sm text-white/60">
              Not configured. Set{' '}
              <code className="text-xs bg-white/[0.06] px-1 py-0.5 rounded">GITHUB_APP_*</code>{' '}
              env vars on the pod and restart. Until then the repo picker is hidden from the New
              Mission dialog and agents can&apos;t clone repos through the App.
            </div>
          ) : (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-white/40">App ID</dt>
              <dd className="text-white font-mono">{appId}</dd>
              <dt className="text-white/40">Installation ID</dt>
              <dd className="text-white font-mono">{installationId}</dd>
              <dt className="text-white/40">Installed on</dt>
              <dd className="text-white font-mono">
                {status.account_html_url ? (
                  <a
                    href={status.account_html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline inline-flex items-center gap-1"
                  >
                    {accountLogin}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  accountLogin
                )}
              </dd>
              <dt className="text-white/40">Repository scope</dt>
              <dd className="text-white">
                {status.repository_selection === 'all'
                  ? 'All repositories in the account'
                  : status.repository_selection === 'selected'
                    ? 'Selected repositories'
                    : '—'}
              </dd>
            </dl>
          )}
          {status?.error && (
            <p className="text-xs text-red-400 mt-3">
              GitHub said: <code>{status.error}</code>
            </p>
          )}
        </section>

        {/* Permissions card */}
        {status?.enabled && (
          <section className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-white">Permissions</h2>
              <a
                href={permissionsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-white/50 hover:text-white inline-flex items-center gap-1"
              >
                Manage on GitHub
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <ul className="space-y-2">
              {REQUIRED_PERMISSIONS.map((req) => {
                const state = permissionStatus(status.permissions, req.key, req.expected);
                return (
                  <li
                    key={`${req.key}-${req.expected}`}
                    className="flex items-start gap-3 text-sm"
                  >
                    {state === 'ok' ? (
                      <ShieldCheck className="h-4 w-4 text-emerald-400 mt-0.5 shrink-0" />
                    ) : (
                      <ShieldAlert
                        className={`h-4 w-4 mt-0.5 shrink-0 ${
                          state === 'partial' ? 'text-yellow-400' : 'text-red-400'
                        }`}
                      />
                    )}
                    <div className="flex-1">
                      <div className="text-white">{req.label}</div>
                      <div className="text-white/50 text-xs">{req.rationale}</div>
                      {state !== 'ok' && (
                        <div className="text-xs mt-1">
                          {state === 'partial' ? (
                            <span className="text-yellow-400">
                              App has <code>{status.permissions?.[req.key]}</code>; needs{' '}
                              <code>{req.expected}</code>.
                            </span>
                          ) : (
                            <span className="text-red-400">
                              Not granted. Click <em>Manage on GitHub</em> to add it, then
                              accept the updated permissions in the installation.
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {status.permissions &&
              !status.can_read_contents && (
                <div className="mt-4 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-yellow-200">
                  <strong>Cloning is blocked</strong> until <code>Contents: read</code> is
                  granted. The picker still lists repos (only <code>Metadata: read</code>
                  needed) but every <code>git clone</code> attempt will fail with{' '}
                  <em>repository not found</em>.
                </div>
              )}
          </section>
        )}

        {/* Repositories card */}
        {status?.enabled && (
          <section className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-white">
                Repositories ({repos?.length ?? 0})
              </h2>
              <a
                href={installationUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-white/50 hover:text-white inline-flex items-center gap-1"
              >
                Manage installation
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            {reposLoading && (
              <p className="text-sm text-white/40">Loading…</p>
            )}
            {reposError instanceof Error && (
              <p className="text-sm text-red-400">{reposError.message}</p>
            )}
            {repos && repos.length === 0 && (
              <p className="text-sm text-white/40">
                The installation can&apos;t see any repos. Add some via{' '}
                <em>Manage installation</em>.
              </p>
            )}
            {repos && repos.length > 0 && (
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                {repos.map((repo) => (
                  <li
                    key={repo.id}
                    className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-white/[0.03]"
                  >
                    <span className="font-mono text-xs text-white/80 flex-1 truncate">
                      {repo.full_name}
                    </span>
                    <span className="text-xs text-white/30">{repo.default_branch}</span>
                    {repo.private && (
                      <span className="text-[10px] uppercase text-white/30 px-1 border border-white/10 rounded">
                        private
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* Troubleshooting card */}
        <section className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-5">
          <h2 className="text-sm font-medium text-white mb-3">Troubleshooting</h2>
          <ul className="text-sm text-white/60 space-y-2 list-disc list-inside">
            <li>
              <strong className="text-white/80">Clone fails with &quot;repository not found&quot;:</strong>{' '}
              GitHub returns this for both nonexistent repos AND repos the App lacks
              <code className="text-xs bg-white/[0.06] px-1 py-0.5 rounded mx-1">Contents: read</code>
              for. If you can see the repo in the list above, it&apos;s the permission.
            </li>
            <li>
              <strong className="text-white/80">After updating permissions on GitHub:</strong> An
              org admin must <em>accept the new permissions</em> in the installation page (link
              above) — GitHub doesn&apos;t auto-apply permission additions to existing
              installations.
            </li>
            <li>
              <strong className="text-white/80">Token rotates every ~1h:</strong> Long-running
              missions that push 1h+ after start may need a re-mint. (v1 mints once at clone time.)
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
