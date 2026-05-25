'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Plus, X, ExternalLink, RefreshCw, SlidersHorizontal } from 'lucide-react';
import useSWR from 'swr';
import { getVisibleAgents, getSandboxedConfig, listBackends, listBackendAgents, getClaudeCodeConfig, getLibraryOpenCodeSettingsForProfile, listBackendModelOptions, listProviders, listGithubRepositories, type Backend, type BackendAgent, type BackendModelOption, type ModelEffort, type Provider, type GithubRepo, type RepoSelection } from '@/lib/api';
import type { Workspace } from '@/lib/api';
import { isBackendAvailable, useBackendConfigs } from '@/lib/use-backend-configs';

const KNOWN_BACKEND_IDS = ['opencode', 'claudecode', 'codex', 'gemini', 'grok'] as const;

// Default "New Mission" picks: Claude Code backend, max reasoning, latest
// Opus model. Edit mode bypasses these in favour of the mission's existing
// settings via `initialValues`.
const DEFAULT_NEW_MISSION_BACKEND = 'claudecode' as const;
const DEFAULT_NEW_MISSION_MODEL_EFFORT: ModelEffort = 'max';
const DEFAULT_NEW_MISSION_MODEL_OVERRIDE = 'claude-opus-4-7' as const;

// Kept in sync with src/api/control.rs `normalize_model_effort_for_backend`.
// Codex only accepts the three baseline levels; claudecode also accepts
// xhigh/max. Other backends ignore effort entirely.
const SUPPORTED_EFFORTS_BY_BACKEND: Record<string, readonly ModelEffort[]> = {
  codex: ['low', 'medium', 'high'],
  claudecode: ['low', 'medium', 'high', 'xhigh', 'max'],
};

const isEffortSupportedByBackend = (
  effort: ModelEffort | '',
  backend: string,
): boolean => {
  if (!effort) return true;
  const supported = SUPPORTED_EFFORTS_BY_BACKEND[backend];
  return !!supported && (supported as readonly string[]).includes(effort);
};

/** Options returned by the dialog's getCreateOptions() method */
export interface NewMissionDialogOptions {
  workspaceId?: string;
  agent?: string;
  /** @deprecated Use workspace config profiles instead */
  modelOverride?: string;
  modelEffort?: ModelEffort;
  configProfile?: string | null;
  backend?: string;
  /** Whether the mission will be opened in a new tab (skip local state updates) */
  openInNewTab?: boolean;
  /** GitHub repos picked in the dialog. The backend clones each into
   * `<mission_workspace>/repos/<name>/` before the agent starts. */
  initialRepos?: RepoSelection[];
}

export interface CreatedMission {
  id: string;
}

/** Initial values to pre-fill the dialog (e.g., from current mission) */
export interface InitialMissionValues {
  workspaceId?: string;
  agent?: string;
  backend?: string;
  modelOverride?: string;
  modelEffort?: ModelEffort;
  configProfile?: string | null;
}

interface NewMissionDialogProps {
  workspaces: Workspace[];
  disabled?: boolean;
  /** Creates a mission and returns its ID for navigation */
  onCreate: (options?: NewMissionDialogOptions) => Promise<CreatedMission>;
  /** Path to the control page (default: '/control') */
  controlPath?: string;
  /** Initial values to pre-fill the form (from current mission) */
  initialValues?: InitialMissionValues;
  /** Auto-open the dialog on mount (e.g., when navigating from workspaces page) */
  autoOpen?: boolean;
  /** Callback when dialog closes (for clearing URL params, etc.) */
  onClose?: () => void;
  /** Use the same controls to edit an existing mission's future run settings. */
  mode?: 'create' | 'edit';
  /** Disable workspace changes, useful when editing an existing mission. */
  lockWorkspace?: boolean;
}

// Combined agent with backend info
interface CombinedAgent {
  backend: string;
  backendName: string;
  agent: string;
  displayName: string; // User-friendly name for UI display
  value: string; // "backend:agent" format
}

// Parse agent names from API response
const parseAgentNames = (payload: unknown): string[] => {
  const normalizeEntry = (entry: unknown): string | null => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === 'string') return name;
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string') return id;
    }
    return null;
  };

  const raw = Array.isArray(payload)
    ? payload
    : (payload as { agents?: unknown })?.agents;
  if (!Array.isArray(raw)) return [];

  const names = raw
    .map(normalizeEntry)
    .filter((name): name is string => Boolean(name));
  return Array.from(new Set(names));
};

const parseAgentNamesFromSettings = (settings: Record<string, unknown> | null | undefined): string[] => {
  if (!settings) return [];
  const agents = (settings as { agents?: unknown }).agents;
  if (!agents) return [];
  if (Array.isArray(agents)) {
    return parseAgentNames(agents);
  }
  if (agents && typeof agents === 'object') {
    return Object.keys(agents as Record<string, unknown>);
  }
  return [];
};

export function NewMissionDialog({
  workspaces,
  disabled = false,
  onCreate,
  controlPath = '/control',
  initialValues,
  autoOpen = false,
  onClose,
  mode = 'create',
  lockWorkspace = false,
}: NewMissionDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(autoOpen);
  const [newMissionWorkspace, setNewMissionWorkspace] = useState('');
  // Repos picked from the GitHub-App-backed multi-select. Keyed by full_name.
  const [selectedRepos, setSelectedRepos] = useState<Map<string, RepoSelection>>(
    new Map(),
  );
  const [repoFilter, setRepoFilter] = useState('');
  // Combined value: "backend:agent" or empty for default
  const [selectedAgentValue, setSelectedAgentValue] = useState('');
  const [modelOverride, setModelOverride] = useState('');
  const [modelEffort, setModelEffort] = useState<ModelEffort | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [defaultSet, setDefaultSet] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const prevBackendRef = useRef<string | null>(null);
  const isEditMode = mode === 'edit';

  useEffect(() => {
    setMounted(true);
  }, []);

  // SWR: fetch backends
  const { data: backends, isLoading: backendsLoading } = useSWR<Backend[]>(
    open ? 'backends' : null,
    listBackends,
    {
    revalidateOnFocus: false,
    dedupingInterval: 30000,
    fallbackData: [
      { id: 'opencode', name: 'OpenCode' },
      { id: 'claudecode', name: 'Claude Code' },
      { id: 'codex', name: 'Codex' },
      { id: 'gemini', name: 'Gemini CLI' },
      { id: 'grok', name: 'Grok Build' },
    ],
    }
  );

  // SWR: fetch backend configs to check enabled / cli / auth status for every
  // known backend in one request.
  const { configs: backendConfigs } = useBackendConfigs(KNOWN_BACKEND_IDS);

  const { data: providersResponse, isLoading: providersLoading } = useSWR(
    open && selectedAgentValue ? 'model-providers' : null,
    () => listProviders({ includeAll: true }),
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );
  const { data: backendModelOptions, mutate: mutateBackendModelOptions, isLoading: modelOptionsLoading } = useSWR(
    open && selectedAgentValue ? 'backend-model-options' : null,
    () => listBackendModelOptions({ includeAll: true }),
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );

  // Filter to only enabled backends with CLI available and (when reported) auth configured.
  const enabledBackends = useMemo(() => {
    return backends?.filter((b) => isBackendAvailable(backendConfigs[b.id])) || [];
  }, [backends, backendConfigs]);

  // SWR: fetch agents for each enabled backend
  const { data: opencodeAgents, mutate: mutateOpencodeAgents } = useSWR<BackendAgent[]>(
    open && enabledBackends.some(b => b.id === 'opencode') ? 'backend-opencode-agents' : null,
    () => listBackendAgents('opencode'),
    { revalidateOnFocus: true, dedupingInterval: 5000 }
  );
  const { data: claudecodeAgents, mutate: mutateClaudecodeAgents } = useSWR<BackendAgent[]>(
    open && enabledBackends.some(b => b.id === 'claudecode') ? 'backend-claudecode-agents' : null,
    () => listBackendAgents('claudecode'),
    { revalidateOnFocus: true, dedupingInterval: 5000 }
  );
  const { data: codexAgents, mutate: mutateCodexAgents } = useSWR<BackendAgent[]>(
    open && enabledBackends.some(b => b.id === 'codex') ? 'backend-codex-agents' : null,
    () => listBackendAgents('codex'),
    { revalidateOnFocus: true, dedupingInterval: 5000 }
  );
  const { data: geminiAgents, mutate: mutateGeminiAgents } = useSWR<BackendAgent[]>(
    open && enabledBackends.some(b => b.id === 'gemini') ? 'backend-gemini-agents' : null,
    () => listBackendAgents('gemini'),
    { revalidateOnFocus: true, dedupingInterval: 5000 }
  );
  const { data: grokAgents, mutate: mutateGrokAgents } = useSWR<BackendAgent[]>(
    open && enabledBackends.some(b => b.id === 'grok') ? 'backend-grok-agents' : null,
    () => listBackendAgents('grok'),
    { revalidateOnFocus: true, dedupingInterval: 5000 }
  );

  // SWR: fetch GitHub repos the App's installation can see. Resolves to
  // `null` (not error) when the App isn't configured → picker hides.
  const {
    data: githubRepos,
    isLoading: githubReposLoading,
    error: githubReposError,
    mutate: mutateGithubRepos,
  } = useSWR<GithubRepo[] | null>(
    open && !isEditMode ? 'github-repositories' : null,
    listGithubRepositories,
    { revalidateOnFocus: false, dedupingInterval: 5 * 60 * 1000 },
  );
  const githubReposAvailable = githubRepos !== null && githubRepos !== undefined;

  // SWR: fallback for opencode agents
  const { data: agentsPayload, mutate: mutateAgentsPayload } = useSWR(open ? 'opencode-agents' : null, getVisibleAgents, {
    revalidateOnFocus: true,
    dedupingInterval: 5000,
  });
  const { data: config, mutate: mutateConfig } = useSWR(open ? 'sandboxed-config' : null, getSandboxedConfig, {
    revalidateOnFocus: true,
    dedupingInterval: 5000,
  });

  // SWR: fetch Claude Code config for hidden agents
  const { data: claudeCodeLibConfig } = useSWR(
    open && enabledBackends.some(b => b.id === 'claudecode') ? 'claudecode-lib-config' : null,
    getClaudeCodeConfig,
    { revalidateOnFocus: false, dedupingInterval: 30000 }
  );

  const workspaceProfile = useMemo(() => {
    const targetWorkspace = newMissionWorkspace
      ? workspaces.find((workspace) => workspace.id === newMissionWorkspace)
      : workspaces.find((workspace) => workspace.id === '00000000-0000-0000-0000-000000000000')
        || workspaces.find((workspace) => workspace.workspace_type === 'host');
    return targetWorkspace?.config_profile || null;
  }, [newMissionWorkspace, workspaces]);

  const effectiveProfileForAgents = workspaceProfile || 'default';

  const { data: opencodeProfileSettings } = useSWR(
    open && effectiveProfileForAgents ? ['opencode-profile-settings', effectiveProfileForAgents] : null,
    ([, profile]) => getLibraryOpenCodeSettingsForProfile(profile as string),
    { revalidateOnFocus: false, dedupingInterval: 30000 }
  );

  const opencodeProfileAgentNames = useMemo(
    () => parseAgentNamesFromSettings(opencodeProfileSettings as Record<string, unknown> | null),
    [opencodeProfileSettings]
  );

  // Combine all agents from enabled backends
  const allAgents = useMemo((): CombinedAgent[] => {
    const result: CombinedAgent[] = [];
    const openCodeHiddenAgents = config?.hidden_agents || [];
    const claudeCodeHiddenAgents = claudeCodeLibConfig?.hidden_agents || [];

    for (const backend of enabledBackends) {
      // Use consistent {id, name} format for all backends
      let agents: { id: string; name: string }[] = [];

      if (backend.id === 'opencode') {
        // Filter out hidden OpenCode agents by name
        const profileAgents = opencodeProfileAgentNames.map(name => ({ id: name, name }));
        const backendAgents = profileAgents.length > 0 ? profileAgents : (opencodeAgents || []);
        const visibleAgents = backendAgents.filter(a => !openCodeHiddenAgents.includes(a.name));
        if (visibleAgents.length > 0) {
          agents = visibleAgents;
        } else if (backendAgents.length > 0) {
          // If all OpenCode agents are hidden, fall back to the raw list so the backend remains usable.
          agents = backendAgents;
        } else {
          // Fallback to parsing agent names from raw payload
          const fallbackNames = parseAgentNames(agentsPayload).filter(
            name => !openCodeHiddenAgents.includes(name)
          );
          agents = fallbackNames.map(name => ({ id: name, name }));
        }

      } else if (backend.id === 'claudecode') {
        // Filter out hidden Claude Code agents by name
        const allClaudeAgents = claudecodeAgents || [];
        agents = allClaudeAgents.filter(a => !claudeCodeHiddenAgents.includes(a.name));
      } else if (backend.id === 'codex') {
        // Codex agents
        agents = codexAgents || [
          { id: 'default', name: 'Codex Agent' },
        ];
      } else if (backend.id === 'gemini') {
        // Gemini agents
        agents = geminiAgents || [
          { id: 'default', name: 'Gemini Agent' },
        ];
      } else if (backend.id === 'grok') {
        agents = grokAgents || [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ];
      }

      // Use agent.id for CLI value, agent.name for display (consistent across all backends)
      for (const agent of agents) {
        result.push({
          backend: backend.id,
          backendName: backend.name,
          agent: agent.id,
          displayName: agent.name,
          value: `${backend.id}:${agent.id}`,
        });
      }
    }

    return result;
  }, [enabledBackends, opencodeAgents, opencodeProfileAgentNames, claudecodeAgents, codexAgents, geminiAgents, grokAgents, agentsPayload, config, claudeCodeLibConfig]);

  // Group agents by backend for display
  const agentsByBackend = useMemo(() => {
    const groups: Record<string, CombinedAgent[]> = {};
    for (const agent of allAgents) {
      if (!groups[agent.backend]) {
        groups[agent.backend] = [];
      }
      groups[agent.backend].push(agent);
    }
    return groups;
  }, [allAgents]);

  // Parse selected value to get backend and agent
  const parseSelectedValue = (value: string): { backend: string; agent?: string } | null => {
    if (!value) return null;
    const [backend, ...agentParts] = value.split(':');
    const agent = agentParts.join(':'); // Handle agent names with colons
    return backend ? { backend, agent: agent || undefined } : null;
  };

  const preservedSelectedAgent = useMemo(() => {
    const parsed = parseSelectedValue(selectedAgentValue);
    if (!parsed) return null;
    if (allAgents.some(a => a.value === selectedAgentValue)) return null;

    const backendHasDefaultOption =
      !parsed.agent &&
      enabledBackends.some(backend => backend.id === parsed.backend) &&
      (agentsByBackend[parsed.backend]?.length || 0) > 0;
    if (backendHasDefaultOption) return null;

    const backendName = backends?.find(backend => backend.id === parsed.backend)?.name || parsed.backend;
    return {
      backendName,
      label: parsed.agent ? `${parsed.agent} (current)` : `${backendName} default (current)`,
      value: selectedAgentValue,
    };
  }, [agentsByBackend, allAgents, backends, enabledBackends, selectedAgentValue]);

  const selectedBackend = useMemo(() => {
    return parseSelectedValue(selectedAgentValue)?.backend || 'claudecode';
  }, [selectedAgentValue]);

  const providerAllowlist = useMemo(() => {
    if (selectedBackend === 'claudecode') return new Set(['anthropic']);
    if (selectedBackend === 'codex') return new Set(['openai']);
    if (selectedBackend === 'gemini') return new Set(['google']);
    if (selectedBackend === 'grok') return new Set(['xai']);
    return null;
  }, [selectedBackend]);

  const modelOptions = useMemo(() => {
    const backendOptions = backendModelOptions?.backends?.[selectedBackend];
    if (backendOptions && backendOptions.length > 0) {
      return backendOptions as BackendModelOption[];
    }
    const providers = (providersResponse?.providers || []) as Provider[];
    const options: Array<{ value: string; label: string; description?: string }> = [];
    for (const provider of providers) {
      if (providerAllowlist && !providerAllowlist.has(provider.id)) continue;
      for (const model of provider.models) {
        const value =
          selectedBackend === 'opencode'
            ? `${provider.id}/${model.id}`
            : model.id;
        options.push({
          value,
          label: `${provider.name} · ${model.name}`,
          description: model.description,
        });
      }
    }
    return options;
  }, [backendModelOptions, providersResponse, providerAllowlist, selectedBackend]);

  const formatWorkspaceType = (type: Workspace['workspace_type']) =>
    type === 'host' ? 'host' : 'isolated';

  // Escape closes the modal. Clicks outside the dialog (i.e. on the backdrop)
  // close it as well — handled inline on the backdrop element below so the
  // modal works correctly when rendered via createPortal outside this tree.
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setDefaultSet(false);
        onClose?.();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  // Revalidate backend model options when dialog opens to pick up chain configuration changes
  useEffect(() => {
    if (open) {
      mutateBackendModelOptions();
    }
  }, [open, mutateBackendModelOptions]);

  // Set initial values when dialog opens (only once per open)
  useEffect(() => {
    if (!open || defaultSet) return;
    // Wait for config to finish loading
    if (config === undefined) return;
    // Wait for agents to load
    if (allAgents.length === 0) return;

    // Set workspace from initialValues if provided
    if (initialValues?.workspaceId) {
      setNewMissionWorkspace(initialValues.workspaceId);
    }

    // Model override / effort: prefer `initialValues` (edit mode or current-
    // mission carry-over). In create mode without explicit values, prime with
    // the New-Mission defaults (claude-opus-4-7 / max). The
    // backend-switch effect downstream will clear these if the user picks a
    // different backend that doesn't support them.
    if (initialValues?.modelOverride) {
      setModelOverride(initialValues.modelOverride);
    } else if (!isEditMode) {
      setModelOverride(DEFAULT_NEW_MISSION_MODEL_OVERRIDE);
    }
    if (initialValues?.modelEffort) {
      setModelEffort(initialValues.modelEffort);
    } else if (!isEditMode) {
      setModelEffort(DEFAULT_NEW_MISSION_MODEL_EFFORT);
    }

    // Try to use initialValues for agent/backend (from current mission)
    if (initialValues?.backend) {
      const currentAgentValue = `${initialValues.backend}:${initialValues.agent || ''}`;
      if (!initialValues.agent) {
        setSelectedAgentValue(currentAgentValue);
        setDefaultSet(true);
        return;
      }
      const matchingAgent = allAgents.find(
        a => a.backend === initialValues.backend && a.agent === initialValues.agent
      );
      if (matchingAgent) {
        setSelectedAgentValue(matchingAgent.value);
        setDefaultSet(true);
        return;
      }
      setSelectedAgentValue(currentAgentValue);
      setDefaultSet(true);
      return;
    }

    // Create mode default: Claude Code backend with its default agent. We
    // intentionally skip `config?.default_agent` here so the New Mission
    // flow always lands on Claude Code unless the user changes it. (Edit
    // mode always supplies `initialValues.backend` and never reaches here.)
    if (!isEditMode) {
      const claudecodeEnabled = enabledBackends.some(b => b.id === DEFAULT_NEW_MISSION_BACKEND);
      if (claudecodeEnabled) {
        setSelectedAgentValue(`${DEFAULT_NEW_MISSION_BACKEND}:`);
        setDefaultSet(true);
        return;
      }
    }

    // Fallback: try to find the default agent from config (used when Claude
    // Code isn't enabled in this install, or for edit-mode safety).
    if (config?.default_agent) {
      const defaultAgent = allAgents.find(a => a.agent === config.default_agent);
      if (defaultAgent) {
        setSelectedAgentValue(defaultAgent.value);
        setDefaultSet(true);
        return;
      }
    }

    // Fallback: use first available backend with priority claudecode → opencode → grok → gemini → codex
    // Try Claude Code first
    const claudeCodeAgent = allAgents.find(a => a.backend === 'claudecode');
    if (claudeCodeAgent) {
      setSelectedAgentValue(claudeCodeAgent.value);
      setDefaultSet(true);
      return;
    }

    // Try OpenCode second (prefer Sisyphus if available)
    const sisyphus = allAgents.find(a => a.backend === 'opencode' && a.agent === 'Sisyphus');
    if (sisyphus) {
      setSelectedAgentValue(sisyphus.value);
      setDefaultSet(true);
      return;
    }
    const openCodeAgent = allAgents.find(a => a.backend === 'opencode');
    if (openCodeAgent) {
      setSelectedAgentValue(openCodeAgent.value);
      setDefaultSet(true);
      return;
    }

    for (const backendId of ['grok', 'gemini', 'codex']) {
      const agent = allAgents.find(a => a.backend === backendId);
      if (agent) {
        setSelectedAgentValue(agent.value);
        setDefaultSet(true);
        return;
      }
    }

    // Final fallback: use first available agent (shouldn't reach here)
    if (allAgents.length > 0) {
      setSelectedAgentValue(allAgents[0].value);
    }
    setDefaultSet(true);
  }, [open, defaultSet, allAgents, config, initialValues, isEditMode, enabledBackends]);

  useEffect(() => {
    // Clear effort if the current selection isn't valid for the selected
    // backend. Codex only supports low/medium/high — leaving "xhigh"/"max"
    // in state when switching from claudecode would silently render as
    // "Default effort" in the dropdown (no matching <option>) while POSTing
    // the stale invalid value.
    if (modelEffort && !isEffortSupportedByBackend(modelEffort, selectedBackend)) {
      setModelEffort('');
    }
    // When switching backends, clear model override if current value isn't valid for the new backend
    if (prevBackendRef.current !== null && prevBackendRef.current !== selectedBackend && modelOverride) {
      const isValidForNewBackend = modelOptions.some(opt => opt.value === modelOverride);
      if (!isValidForNewBackend) {
        setModelOverride('');
      }
    }
    prevBackendRef.current = selectedBackend;
  }, [selectedBackend, modelOverride, modelEffort, modelOptions]);

  const resetForm = () => {
    setNewMissionWorkspace('');
    setSelectedRepos(new Map());
    setRepoFilter('');
    setSelectedAgentValue('');
    setModelOverride('');
    setModelEffort('');
    setDefaultSet(false);
  };

  const handleClose = () => {
    setOpen(false);
    resetForm();
    onClose?.();
  };

  const handleRefreshAgents = async () => {
    // Revalidate all agent lists
    await Promise.all([
      mutateOpencodeAgents?.(),
      mutateClaudecodeAgents?.(),
      mutateCodexAgents?.(),
      mutateGeminiAgents?.(),
      mutateGrokAgents?.(),
      mutateAgentsPayload?.(),
      mutateConfig?.(),
    ]);
  };

  const getCreateOptions = (): NewMissionDialogOptions => {
    const parsed = parseSelectedValue(selectedAgentValue);
    const agentValue =
      (selectedBackend === 'gemini' && parsed?.agent === 'default') ||
      (selectedBackend === 'grok' && parsed?.agent === 'build')
        ? undefined
        : parsed?.agent || undefined;
    const trimmedModel = modelOverride.trim();
    const normalizedModel =
      selectedBackend === 'opencode'
        ? trimmedModel
        : trimmedModel.includes('/')
          ? trimmedModel.split('/').pop() || ''
          : trimmedModel;
    const modelOverrideValue =
      !normalizedModel ? undefined : normalizedModel;
    const modelEffortValue =
      modelEffort && isEffortSupportedByBackend(modelEffort, selectedBackend)
        ? modelEffort
        : undefined;
    return {
      workspaceId: newMissionWorkspace || undefined,
      agent: agentValue,
      backend: parsed?.backend || 'claudecode',
      modelOverride: modelOverrideValue,
      modelEffort: modelEffortValue,
      configProfile: isEditMode
        ? initialValues?.configProfile ?? null
        : workspaceProfile || undefined,
      initialRepos:
        selectedRepos.size > 0 ? Array.from(selectedRepos.values()) : undefined,
    };
  };

  const handleCreate = async (openInNewTab: boolean) => {
    if (disabled || submitting) return;
    const pendingTab = openInNewTab ? window.open('about:blank', '_blank') : null;
    if (pendingTab) {
      pendingTab.opener = null;
    }
    setSubmitting(true);
    try {
      const options = getCreateOptions();
      const mission = await onCreate({ ...options, openInNewTab });
      if (isEditMode) {
        setOpen(false);
        onClose?.();
        return;
      }
      const url = `${controlPath}?mission=${mission.id}`;

      if (openInNewTab) {
        let opened = false;
        if (pendingTab && !pendingTab.closed) {
          try {
            pendingTab.location.href = url;
            opened = true;
          } catch {
            opened = false;
          }
        }
        if (!opened && !window.open(url, '_blank')) {
          router.push(url);
        }
        setOpen(false);
        resetForm();
        onClose?.();
      } else {
        // Close dialog state first, then navigate.
        // Do NOT call onClose here – it would trigger router.replace('/')
        // which overwrites the router.push below and prevents navigation
        // to the control page.
        setOpen(false);
        resetForm();
        router.push(url);
      }
    } catch (err) {
      if (pendingTab && !pendingTab.closed) {
        pendingTab.close();
      }
      throw err;
    } finally {
      setSubmitting(false);
    }
  };

  const isBusy = disabled || submitting;

  return (
    <div className="relative" ref={dialogRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={isBusy}
        className={isEditMode
          ? "flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-sm text-white/70 hover:bg-white/[0.04] transition-colors disabled:opacity-50"
          : "flex items-center gap-1.5 rounded-lg bg-indigo-500/20 px-2.5 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/30 transition-colors disabled:opacity-50"}
        title={isEditMode ? "Edit mission run settings" : "Create new mission"}
      >
        {isEditMode ? <SlidersHorizontal className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        <span className="hidden lg:inline">{isEditMode ? 'Run Settings' : 'New Mission'}</span>
      </button>
      {open && mounted && createPortal(
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-mission-dialog-title"
        >
          {/* Backdrop — click to dismiss */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
            onClick={() => {
              setOpen(false);
              setDefaultSet(false);
              onClose?.();
            }}
          />

          {/* Modal */}
          <div
            ref={modalRef}
            className="relative w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-white/[0.06] bg-[#1a1a1a] p-4 shadow-2xl animate-in fade-in zoom-in-95 duration-150 mx-4"
          >
          {/* Header with refresh and close buttons */}
          <div className="flex items-center justify-between mb-3">
            <h3 id="new-mission-dialog-title" className="text-sm font-medium text-white">
              {isEditMode ? 'Edit Run Settings' : 'Create New Mission'}
            </h3>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleRefreshAgents}
                className="p-1 rounded-md text-white/40 hover:text-white/70 hover:bg-white/[0.04] transition-colors"
                title="Refresh agent list"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="p-1 rounded-md text-white/40 hover:text-white/70 hover:bg-white/[0.04] transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {/* Workspace selection */}
            <div>
              <label className="block text-xs text-white/50 mb-1.5">Workspace</label>
              <select
                value={newMissionWorkspace}
                onChange={(e) => setNewMissionWorkspace(e.target.value)}
                disabled={lockWorkspace}
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-sm text-white focus:border-indigo-500/50 focus:outline-none appearance-none cursor-pointer"
                style={{
                  backgroundImage:
                    "url(\"data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e\")",
                  backgroundPosition: 'right 0.5rem center',
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: '1.5em 1.5em',
                  paddingRight: '2.5rem',
                }}
              >
                <option value="" className="bg-[#1a1a1a]">
                  Host (default)
                </option>
                {workspaces
                  .filter(
                    (ws) =>
                      ws.status === 'ready' &&
                      ws.id !== '00000000-0000-0000-0000-000000000000'
                  )
                  .map((workspace) => (
                    <option
                      key={workspace.id}
                      value={workspace.id}
                      className="bg-[#1a1a1a]"
                    >
                      {workspace.name} ({formatWorkspaceType(workspace.workspace_type)})
                    </option>
                  ))}
              </select>
              <p className="text-xs text-white/30 mt-1.5">Where the mission will run</p>
            </div>

            {/* GitHub repos picker (hidden when App not configured or in edit mode) */}
            {!isEditMode && githubReposAvailable && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs text-white/50">
                    Repositories ({selectedRepos.size} picked)
                  </label>
                  <button
                    type="button"
                    onClick={() => mutateGithubRepos()}
                    title="Refresh repo list"
                    className="p-1 rounded text-white/40 hover:text-white/70 hover:bg-white/[0.04] transition-colors"
                  >
                    <RefreshCw className={`h-3 w-3 ${githubReposLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                {/* Selected repos as chips */}
                {selectedRepos.size > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {Array.from(selectedRepos.values()).map((sel) => {
                      const repo = githubRepos?.find((r) => r.full_name === sel.full_name);
                      const branchLabel = sel.branch?.trim() || repo?.default_branch || 'default';
                      return (
                        <span
                          key={sel.full_name}
                          className="inline-flex items-center gap-1.5 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-xs text-white/90"
                        >
                          <span className="font-mono">{sel.full_name}</span>
                          <span className="text-white/50">@</span>
                          <input
                            type="text"
                            value={sel.branch ?? ''}
                            placeholder={repo?.default_branch || 'branch'}
                            onChange={(e) => {
                              setSelectedRepos((prev) => {
                                const next = new Map(prev);
                                next.set(sel.full_name, {
                                  full_name: sel.full_name,
                                  branch: e.target.value || undefined,
                                });
                                return next;
                              });
                            }}
                            className="w-20 bg-transparent border-b border-white/10 focus:border-indigo-500/50 focus:outline-none text-xs text-white/80"
                            title={`Default branch: ${branchLabel}`}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedRepos((prev) => {
                                const next = new Map(prev);
                                next.delete(sel.full_name);
                                return next;
                              });
                            }}
                            className="text-white/40 hover:text-white/80"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Filter + checkbox list */}
                <input
                  type="text"
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                  placeholder="Filter forgecart/* repos…"
                  className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-indigo-500/50 focus:outline-none"
                />
                <div className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-white/[0.04] bg-white/[0.01]">
                  {githubReposLoading && (
                    <div className="p-2 text-xs text-white/40">Loading repos…</div>
                  )}
                  {!githubReposLoading && githubRepos && githubRepos.length === 0 && (
                    <div className="p-2 text-xs text-white/40">
                      The GitHub App installation can&apos;t see any repos.
                    </div>
                  )}
                  {githubRepos
                    ?.filter((r) => {
                      if (!repoFilter.trim()) return true;
                      return r.full_name
                        .toLowerCase()
                        .includes(repoFilter.trim().toLowerCase());
                    })
                    .slice(0, 50)
                    .map((repo) => {
                      const checked = selectedRepos.has(repo.full_name);
                      return (
                        <label
                          key={repo.id}
                          className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/[0.03] cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSelectedRepos((prev) => {
                                const next = new Map(prev);
                                if (e.target.checked) {
                                  next.set(repo.full_name, {
                                    full_name: repo.full_name,
                                    branch: undefined,
                                  });
                                } else {
                                  next.delete(repo.full_name);
                                }
                                return next;
                              });
                            }}
                            className="h-3.5 w-3.5"
                          />
                          <span className="font-mono text-xs text-white/80">{repo.full_name}</span>
                          <span className="text-xs text-white/30">
                            default: {repo.default_branch}
                          </span>
                          {repo.private && (
                            <span className="text-[10px] uppercase text-white/30 px-1 border border-white/10 rounded">
                              private
                            </span>
                          )}
                        </label>
                      );
                    })}
                </div>
                {githubReposError && (
                  <p className="text-xs text-red-400 mt-1">{githubReposError.message}</p>
                )}
                <p className="text-xs text-white/30 mt-1.5">
                  Cloned into <code>{'<mission_workspace>/repos/<name>/'}</code> before the agent starts.
                </p>
              </div>
            )}

            {/* Agent selection (includes backend) */}
            <div>
              <label className="block text-xs text-white/50 mb-1.5">Agent</label>
              <select
                value={selectedAgentValue}
                onChange={(e) => setSelectedAgentValue(e.target.value)}
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-sm text-white focus:border-indigo-500/50 focus:outline-none appearance-none cursor-pointer"
                style={{
                  backgroundImage:
                    "url(\"data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e\")",
                  backgroundPosition: 'right 0.5rem center',
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: '1.5em 1.5em',
                  paddingRight: '2.5rem',
                }}
              >
                {(backendsLoading || allAgents.length === 0) && (
                  <option value="" className="bg-[#1a1a1a]">
                    Loading agents…
                  </option>
                )}
                {preservedSelectedAgent && (
                  <optgroup
                    key="current-agent"
                    label={`${preservedSelectedAgent.backendName} (current)`}
                    className="bg-[#1a1a1a]"
                  >
                    <option value={preservedSelectedAgent.value} className="bg-[#1a1a1a]">
                      {preservedSelectedAgent.label}
                    </option>
                  </optgroup>
                )}
                {enabledBackends.map((backend) => {
                  const backendAgentsList = agentsByBackend[backend.id] || [];
                  if (backendAgentsList.length === 0) return null;

                  return (
                    <optgroup key={backend.id} label={backend.name} className="bg-[#1a1a1a]">
                      <option value={`${backend.id}:`} className="bg-[#1a1a1a]">
                        {backend.name} default
                      </option>
                      {backendAgentsList.map((agent) => (
                        <option key={agent.value} value={agent.value} className="bg-[#1a1a1a]">
                          {agent.displayName}{agent.backend === 'opencode' && agent.agent === 'Sisyphus' ? ' (recommended)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              <p className="text-xs text-white/30 mt-1.5">
                Select an agent and backend to power this mission
              </p>
            </div>

            {/* Model override */}
            <div>
              <label className="block text-xs text-white/50 mb-1.5">Model override (optional)</label>
              <select
                value={modelOverride}
                onChange={(e) => setModelOverride(e.target.value)}
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-sm text-white focus:border-indigo-500/50 focus:outline-none disabled:opacity-60 [&>option]:bg-slate-800 [&>option]:text-white [&>optgroup]:bg-slate-900 [&>optgroup]:text-white/70"
              >
                <option value="">No override (use default)</option>
                {(() => {
                  if (modelOptionsLoading || providersLoading) {
                    return (
                      <option value="" disabled>
                        Loading model options…
                      </option>
                    );
                  }
                  // Group options by provider
                  const groupedOptions = new Map<string, Array<{ value: string; label: string; description?: string; provider_id?: string }>>();

                  for (const option of modelOptions) {
                    // Extract provider from the label (format: "Provider Name · Model Name")
                    const labelParts = option.label.split(/\s[—·]\s/);
                    const providerName = labelParts[0] || 'Other';
                    if (!groupedOptions.has(providerName)) {
                      groupedOptions.set(providerName, []);
                    }
                    groupedOptions.get(providerName)!.push(option);
                  }

                  return Array.from(groupedOptions.entries()).map(([providerName, options]) => {
                    // For custom providers, include the provider ID in the label
                    const firstOption = options[0];
                    const groupLabel = firstOption?.provider_id
                      ? `${providerName} (ID: ${firstOption.provider_id})`
                      : providerName;

                    return (
                      <optgroup key={providerName} label={groupLabel}>
                        {options.map((option) => {
                          // Extract just the model name from the label
                          const modelName = option.label.split(/\s[—·]\s/)[1] || option.label;
                          const displayText = option.description
                            ? `${modelName} - ${option.description}`
                            : modelName;
                          return (
                            <option key={option.value} value={option.value}>
                              {displayText}
                            </option>
                          );
                        })}
                      </optgroup>
                    );
                  });
                })()}
              </select>
              <p className="text-xs text-white/30 mt-1.5">
                {selectedBackend === 'opencode'
                    ? 'Use provider/model format (e.g., openai/gpt-5-codex).'
                    : 'Use the raw model ID (e.g., gpt-5-codex or claude-opus-4-7).'}
              </p>
            </div>

            {(selectedBackend === 'codex' || selectedBackend === 'claudecode') && (
              <div>
                <label className="block text-xs text-white/50 mb-1.5">Model effort (optional)</label>
                <select
                  value={modelEffort}
                  onChange={(e) => setModelEffort(e.target.value as ModelEffort | '')}
                  className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-sm text-white focus:border-indigo-500/50 focus:outline-none [&>option]:bg-slate-800 [&>option]:text-white"
                >
                  <option value="">Default effort</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  {selectedBackend === 'claudecode' && <option value="xhigh">XHigh</option>}
                  {selectedBackend === 'claudecode' && <option value="max">Max</option>}
                </select>
                <p className="text-xs text-white/30 mt-1.5">
                  {selectedBackend === 'codex' ? 'Passed to Codex as reasoning effort.' : 'Controls Claude Code adaptive reasoning depth (via CLAUDE_CODE_EFFORT_LEVEL).'}
                </p>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={isEditMode ? handleClose : () => handleCreate(false)}
                disabled={isBusy && !isEditMode}
                className="flex-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-white/70 hover:bg-white/[0.04] transition-colors disabled:opacity-50"
              >
                {isEditMode ? 'Cancel' : 'Create here'}
              </button>
              {isEditMode ? (
                <button
                  type="button"
                  onClick={() => handleCreate(false)}
                  disabled={isBusy}
                  className="flex-1 flex items-center justify-center rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-600 transition-colors disabled:opacity-50"
                >
                  Save
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleCreate(true)}
                  disabled={isBusy}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-600 transition-colors disabled:opacity-50"
                >
                  New Tab
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
