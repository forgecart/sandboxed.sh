"use client";

import type React from "react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  memo,
  startTransition,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import {
  MarkdownContent,
  LazyMarkdownContent,
} from "@/components/markdown-content";
import { StreamingMarkdown } from "@/components/streaming-markdown";
import {
  EnhancedInput,
  type SubmitPayload,
  type EnhancedInputHandle,
  type FilePasteContext,
} from "@/components/enhanced-input";
import { MissionAutomationsDialog } from "@/components/mission-automations-dialog";
import { PerfOverlay } from "@/components/perf-overlay";
import { deriveAssistantTurnStatus } from "@/lib/assistant-turn-status";
import { perfBus } from "@/lib/perf-bus";
import { isStreamContinuation } from "@/lib/stream-continuation";
import {
  eventsToItemsImpl,
  isRecord,
  parseCostMetadata,
  parseUsage,
  type ChatItem,
  type TokenUsageRecord,
} from "./events-reducer";
export type { ChatItem } from "./events-reducer";
import {
  useControlItemsStore,
  useControlQueueStore,
  useControlStreamingDiagnosticsStore,
  useControlViewingMissionStore,
  type StreamDiagnosticsState,
} from "./control-stores";
import { NowTickProvider, useNow } from "@/lib/now-tick";
import { startHealthBudgetWatcher } from "@/lib/health-budget";
import { MissionDebugStats } from "./MissionDebugStats";
import { MissionScope } from "./mission-scope";

import { LazyCodeBlock } from "@/components/lazy-code-block";
import { LazyJsonHighlighter } from "@/components/lazy-json-highlighter";
import { cn } from "@/lib/utils";
import { getMissionShortName } from "@/lib/mission-display";
import { inferMissionRole } from "@/lib/mission-role";
import { getMissionDotColor, isFinishedStatus } from "@/lib/mission-status";
import { getRuntimeApiBase } from "@/lib/settings";
import { authHeader } from "@/lib/auth";
import { onFileRef } from "@/lib/file-ref-bus";
import { stripRichFileTagsByName } from "@/lib/rich-tags";
import { readCachedEvents, writeCachedEvents } from "@/lib/event-cache";
import {
  cancelControl,
  postControlMessage,
  postControlToolResult,
  streamControl,
  loadMission,
  markMissionOpened,
  getMission,
  getMissionEventsWithMeta,
  getMissionSnapshot,
  searchMissionMoments,
  createMission,
  updateMissionSettings,
  listMissions,
  setMissionStatus,
  resumeMission,
  getCurrentMission,
  uploadFile,
  uploadFileChunked,
  formatBytes,
  getProgress,
  getRunningMissions,
  isNetworkError,
  cancelMission,
  deleteMission,
  forkMission,
  autoGenerateMissionTitle,
  listWorkspaces,
  getHealth,
  listDesktopSessions,
  closeDesktopSession,
  keepAliveDesktopSession,
  cleanupOrphanedDesktopSessions,
  cleanupStoppedDesktopSessions,
  removeFromQueue,
  clearQueue,
  getQueue,
  type StreamDiagnosticUpdate,
  type ControlRunState,
  type Mission,
  type MissionStatus,
  type ModelEffort,
  type RunningMissionInfo,
  type UploadProgress,
  type Workspace,
  type DesktopSessionDetail,
  type StoredEvent,
  type SharedFile,
  type RepoSelection,
} from "@/lib/api";
import { QueueStrip, type QueueItem } from "@/components/queue-strip";
import { AsyncButton } from "@/components/ui/async-button";
import {
  Send,
  Square,
  Bot,
  User,
  Loader,
  CheckCircle,
  XCircle,
  Ban,
  Clock,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Target,
  Brain,
  Copy,
  Check,
  Paperclip,
  ArrowDown,
  Cpu,
  Layers,
  RefreshCw,
  RotateCcw,
  PlayCircle,
  ListPlus,
  X,
  Wrench,
  Terminal,
  FileText,
  Eye,
  Search,
  Globe,
  Code,
  FolderOpen,
  Trash2,
  Monitor,
  HelpCircle,
  PanelRightClose,
  PanelRight,
  WifiOff,
  AlertTriangle,
  Download,
  Image as ImageIcon,
  FileArchive,
  File,
  ExternalLink,
  MessageSquare,
  Users,
  BriefcaseBusiness,
  GitBranch,
  GitFork,
  Inbox,
  Flag,
} from "lucide-react";
import { IMAGE_PATH_PATTERN } from "@/lib/file-extensions";
import {
  insertTextAtSelection,
  type TextSelection,
} from "@/lib/text-selection";
import { useFaviconStatus } from "@/hooks/use-favicon-status";

type InputInsertionState = TextSelection & {
  insertedCount: number;
};

type MissionDraftCacheEntry = {
  text: string;
  updatedAt: number;
};

const LEGACY_CONTROL_DRAFT_KEY = "control-draft";
const MISSION_DRAFT_CACHE_KEY = "control-mission-drafts-v1";
const MAX_MISSION_DRAFT_CACHE_BYTES = 64 * 1024;
const MAX_MISSION_DRAFT_CACHE_ENTRIES = 50;

type EventsWorkerRequest = {
  id: number;
  events: StoredEvent[];
  mission?: Mission | null;
};

type EventsWorkerResponse =
  | { id: number; ok: true; items: ChatItem[] }
  | { id: number; ok: false; error: string };

function formatDiagAge(ts?: number) {
  if (!ts) return "N/A";
  const deltaMs = Date.now() - ts;
  if (deltaMs < 0) return "N/A";
  const secs = Math.floor(deltaMs / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return `${mins}m ${rem}s ago`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m ago`;
}

function isRetriableSendError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("load failed") ||
    message.includes("network request failed") ||
    message.includes("offline")
  );
}

async function postControlMessageWithRetry(
  content: string,
  options: { agent?: string; mission_id?: string; client_message_id: string },
): Promise<{ id: string; queued: boolean }> {
  try {
    return await postControlMessage(content, options);
  } catch (error) {
    if (!isRetriableSendError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return postControlMessage(content, options);
  }
}

type StreamLogLevel = "debug" | "info" | "warn" | "error";

function streamLog(
  level: StreamLogLevel,
  message: string,
  meta?: Record<string, unknown>,
) {
  const prefix = "[control:sse]";
  const args = meta ? [prefix, message, meta] : [prefix, message];
  switch (level) {
    case "debug":
      console.debug(...args);
      break;
    case "info":
      console.info(...args);
      break;
    case "warn":
      console.warn(...args);
      break;
    case "error":
      console.error(...args);
      break;
  }
}

function readLegacyControlDraft(): string {
  if (typeof window === "undefined") return "";
  try {
    const raw = window.localStorage.getItem(LEGACY_CONTROL_DRAFT_KEY);
    return raw ? (JSON.parse(raw) as string) : "";
  } catch {
    return "";
  }
}

function readMissionDraftCache(): Record<string, MissionDraftCacheEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(MISSION_DRAFT_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, MissionDraftCacheEntry>;
  } catch {
    return {};
  }
}

function writeMissionDraftCache(
  drafts: Record<string, MissionDraftCacheEntry>,
) {
  if (typeof window === "undefined") return;

  const pruned = { ...drafts };
  const removeOldest = () => {
    const oldest = Object.entries(pruned).sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    )[0]?.[0];
    if (oldest) delete pruned[oldest];
    return Boolean(oldest);
  };

  while (Object.keys(pruned).length > MAX_MISSION_DRAFT_CACHE_ENTRIES) {
    if (!removeOldest()) break;
  }

  let encoded = JSON.stringify(pruned);
  while (
    encoded.length > MAX_MISSION_DRAFT_CACHE_BYTES &&
    Object.keys(pruned).length > 0
  ) {
    if (!removeOldest()) break;
    encoded = JSON.stringify(pruned);
  }

  try {
    if (Object.keys(pruned).length === 0) {
      window.localStorage.removeItem(MISSION_DRAFT_CACHE_KEY);
    } else {
      window.localStorage.setItem(MISSION_DRAFT_CACHE_KEY, encoded);
    }
  } catch {
    // Draft persistence is best-effort; storage quota errors should not
    // interfere with sending messages.
  }
}

function loadControlDraftForMission(missionId: string | null): string {
  if (!missionId) return readLegacyControlDraft();

  const drafts = readMissionDraftCache();
  const existing = drafts[missionId];
  if (existing) return existing.text;

  const legacy = readLegacyControlDraft();
  if (legacy) {
    drafts[missionId] = { text: legacy, updatedAt: Date.now() };
    writeMissionDraftCache(drafts);
    try {
      window.localStorage.removeItem(LEGACY_CONTROL_DRAFT_KEY);
    } catch {
      // ignore
    }
  }
  return legacy;
}

function saveControlDraftForMission(text: string, missionId: string | null) {
  if (typeof window === "undefined") return;

  if (!missionId) {
    try {
      if (text) {
        window.localStorage.setItem(
          LEGACY_CONTROL_DRAFT_KEY,
          JSON.stringify(text),
        );
      } else {
        window.localStorage.removeItem(LEGACY_CONTROL_DRAFT_KEY);
      }
    } catch {
      // ignore
    }
    return;
  }

  const drafts = readMissionDraftCache();
  if (text) {
    drafts[missionId] = { text, updatedAt: Date.now() };
  } else {
    delete drafts[missionId];
  }
  writeMissionDraftCache(drafts);
  try {
    window.localStorage.removeItem(LEGACY_CONTROL_DRAFT_KEY);
  } catch {
    // ignore
  }
}

import {
  OptionList,
  OptionListErrorBoundary,
  parseSerializableOptionList,
  type OptionListSelection,
} from "@/components/tool-ui/option-list";
import {
  DataTable,
  parseSerializableDataTable,
} from "@/components/tool-ui/data-table";
import { useVirtualTimelineAnchor } from "@/hooks/use-virtual-timeline-anchor";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useVisibilityPolling } from "@/hooks/use-visibility-polling";
import { DesktopStream } from "@/components/desktop-stream";
import { NewMissionDialog } from "@/components/new-mission-dialog";
import {
  MissionSwitcher,
  normalizeMetadataText,
} from "@/components/mission-switcher";
import { ChangesPanel } from "@/components/changes-panel";
import {
  SubagentsPanel,
  type SubagentEntry,
} from "@/components/subagents-panel";
import { RelativeTime } from "@/components/ui/relative-time";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type SidePanelItem = Extract<ChatItem, { kind: "thinking" | "stream" }>;

// Module-level so all duration consumers share the same implementation.
function formatDuration(seconds: number): string {
  if (seconds <= 0) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m${secs > 0 ? ` ${secs}s` : ""}`;
}

// Renders a live-updating duration string anchored at `startTime`. ONLY this
// component subscribes to `useNow()`, so the 1 Hz tick re-renders just the
// active duration cell — not every visible done item/tool card. Wrapping a
// parent in this child instead of calling `useNow()` directly avoids the
// per-second commit storm we used to get on the thoughts panel (which can
// hold hundreds of done items, each one of which was subscribing for a value
// it never read).
const LiveDuration = memo(function LiveDuration({
  startTime,
}: {
  startTime: number;
}) {
  const nowMs = useNow();
  const seconds = Math.max(0, Math.floor((nowMs - startTime) / 1000));
  return <>{formatDuration(seconds)}</>;
});

type ToolGroup = {
  kind: "tool_group";
  groupId: string;
  tools: ToolItem[];
};
type ThinkingGroup = {
  kind: "thinking_group";
  groupId: string;
  thoughts: SidePanelItem[];
};
type GroupedItem = ChatItem | ToolGroup | ThinkingGroup;

function getGroupedItemKey(item: GroupedItem): string {
  if (item.kind === "tool_group" || item.kind === "thinking_group") {
    return item.groupId;
  }
  return item.id;
}

type ItemViews = {
  /** Items after dedup by `id`, in original order. */
  dedupedItems: ChatItem[];
  /** Deduped + queued-user items moved to the end. */
  displayItems: ChatItem[];
  /** `displayItems` with queued users filtered out (they render in
   * the QueueStrip instead). */
  chatDisplayItems: ChatItem[];
  /** The last non-queued item; used by a few pinned UI bits. */
  lastNonQueuedItem: ChatItem | undefined;
  /** `chatDisplayItems` collapsed into tool / thinking groups. */
  groupedItems: GroupedItem[];
};

/**
 * Single-pass derivation of every view we display from the raw `items`
 * array. Replaces a cascade of 7–8 separate `useMemo` hooks that each
 * looped over `items` independently — on a 5 000-item mission with a
 * 10 Hz SSE stream that was ~35 000 ops/sec just to keep views in
 * sync. Merging into one traversal is O(n) in `items.length` and runs
 * exactly once per `items` change.
 *
 * Keep this pure — it's called from a `useMemo` and must not touch
 * React state or refs.
 */
function deriveItemViews(items: ChatItem[]): ItemViews {
  // Pass 1: dedup by id (last occurrence wins, preserve original order).
  // Record the last index per id, then emit items whose index matches.
  // O(n) with a single map allocation.
  const lastIndexById = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    lastIndexById.set(items[i].id, i);
  }
  let dedupedItems: ChatItem[] = [];
  for (let i = 0; i < items.length; i++) {
    if (lastIndexById.get(items[i].id) === i) {
      dedupedItems.push(items[i]);
    }
  }
  const lastThinkingItemIndexByContent = new Map<string, number>();
  for (let i = 0; i < dedupedItems.length; i++) {
    const item = dedupedItems[i];
    if (item.kind !== "thinking" && item.kind !== "stream") continue;
    const key = item.content.trim();
    if (key) lastThinkingItemIndexByContent.set(key, i);
  }
  if (lastThinkingItemIndexByContent.size > 0) {
    dedupedItems = dedupedItems.filter((item, index) => {
      if (item.kind !== "thinking" && item.kind !== "stream") return true;
      const key = item.content.trim();
      return !key || lastThinkingItemIndexByContent.get(key) === index;
    });
  }

  // Pass 2: detect queued user messages (move them to the end below).
  let hasQueuedUser = false;
  for (const item of dedupedItems) {
    if (item.kind === "user" && item.queued) {
      hasQueuedUser = true;
      break;
    }
  }

  let displayItems: ChatItem[];
  if (!hasQueuedUser) {
    displayItems = dedupedItems;
  } else {
    const normal: ChatItem[] = [];
    const queued: ChatItem[] = [];
    for (const item of dedupedItems) {
      if (item.kind === "user" && item.queued) queued.push(item);
      else normal.push(item);
    }
    displayItems = normal.concat(queued);
  }

  // `chatDisplayItems` is `displayItems` minus queued users. When there
  // are no queued users the two are identical; share the reference so
  // downstream memos see stable identity on the common path.
  const chatDisplayItems = hasQueuedUser
    ? displayItems.filter((it) => !(it.kind === "user" && it.queued === true))
    : displayItems;

  let lastNonQueuedItem: ChatItem | undefined;
  for (let i = displayItems.length - 1; i >= 0; i--) {
    const item = displayItems[i];
    if (!(item.kind === "user" && item.queued)) {
      lastNonQueuedItem = item;
      break;
    }
  }
  if (!lastNonQueuedItem && displayItems.length > 0) {
    lastNonQueuedItem = displayItems[displayItems.length - 1];
  }

  // Pass 3: group consecutive tool/thinking blocks for collapsed display.
  const groupedItems: GroupedItem[] = [];
  let currentToolGroup: ToolItem[] = [];
  let currentThinkingGroup: SidePanelItem[] = [];
  const flushToolGroup = () => {
    if (currentToolGroup.length === 0) return;
    if (currentToolGroup.length === 1) {
      groupedItems.push(currentToolGroup[0]);
    } else {
      groupedItems.push({
        kind: "tool_group",
        groupId: currentToolGroup[0].id,
        tools: currentToolGroup,
      });
    }
    currentToolGroup = [];
  };
  const flushThinkingGroup = () => {
    if (currentThinkingGroup.length === 0) return;
    groupedItems.push({
      kind: "thinking_group",
      groupId: currentThinkingGroup[0].id,
      thoughts: currentThinkingGroup,
    });
    currentThinkingGroup = [];
  };
  for (const item of chatDisplayItems) {
    if (item.kind === "tool" && !item.isUiTool) {
      flushThinkingGroup();
      currentToolGroup.push(item);
    } else if (item.kind === "thinking" || item.kind === "stream") {
      // Thoughts render inline in the main chat. Break the current
      // tool group so ordering renders as tool → thinking → tool.
      flushToolGroup();
      currentThinkingGroup.push(item as SidePanelItem);
    } else {
      flushToolGroup();
      flushThinkingGroup();
      groupedItems.push(item);
    }
  }
  flushToolGroup();
  flushThinkingGroup();

  return {
    dedupedItems,
    displayItems,
    chatDisplayItems,
    lastNonQueuedItem,
    groupedItems,
  };
}

type QuestionOption = {
  label: string;
  description?: string;
};

type QuestionInfo = {
  header?: string;
  question?: string;
  options?: QuestionOption[];
  multiple?: boolean;
  /** True when the only meaningful option is "Other" (free-text input). */
  freeTextOnly?: boolean;
};

function parseQuestionArgs(args: unknown): QuestionInfo[] {
  if (!isRecord(args)) return [];
  const raw = args["questions"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (isRecord(entry) ? entry : null))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => {
      const options = Array.isArray(entry["options"])
        ? entry["options"]
            .map((opt) => (isRecord(opt) ? opt : null))
            .filter((opt): opt is Record<string, unknown> => Boolean(opt))
            .map((opt) => ({
              label: String(opt["label"] ?? ""),
              description:
                typeof opt["description"] === "string"
                  ? opt["description"]
                  : undefined,
            }))
            .filter((opt) => opt.label.length > 0)
        : [];
      // Detect when the only meaningful options are "Other"-like entries,
      // meaning the question expects free-text input.
      const nonOtherOptions = options.filter(
        (opt) => !opt.label.toLowerCase().includes("other"),
      );
      return {
        header:
          typeof entry["header"] === "string" ? entry["header"] : undefined,
        question:
          typeof entry["question"] === "string" ? entry["question"] : undefined,
        options,
        multiple: Boolean(entry["multiple"] ?? entry["multiSelect"]),
        freeTextOnly: options.length > 0 && nonOtherOptions.length === 0,
      };
    })
    .filter((q) => (q.question?.length ?? 0) > 0);
}

function QuestionToolItem({
  item,
  onSubmit,
}: {
  item: ToolItem;
  onSubmit: (toolCallId: string, answers: string[][]) => Promise<void>;
}) {
  const questions = useMemo(() => parseQuestionArgs(item.args), [item.args]);
  const [answers, setAnswers] = useState<string[][]>(() =>
    questions.map(() => []),
  );
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setAnswers(questions.map(() => []));
    setOtherText({});
  }, [item.toolCallId, questions]);

  const hasResult = item.result !== undefined;

  const canSubmit = useMemo(() => {
    if (questions.length === 0) return false;
    return questions.every((q, idx) => {
      const typed = (otherText[idx] ?? "").trim().length > 0;
      if (q.freeTextOnly) return typed;
      // Non-freeTextOnly: accept EITHER a selected option OR a
      // typed free-text answer (the modal's always-visible
      // textarea). Previously only option-selection counted, so
      // submitting a typed-only answer was blocked.
      return (answers[idx] ?? []).length > 0 || typed;
    });
  }, [answers, questions, otherText]);

  const handleToggle = (idx: number, label: string, multiple: boolean) => {
    setAnswers((prev) => {
      const next = [...prev];
      const current = new Set(next[idx] ?? []);
      if (multiple) {
        if (current.has(label)) {
          current.delete(label);
        } else {
          current.add(label);
        }
      } else {
        current.clear();
        current.add(label);
      }
      next[idx] = Array.from(current);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!canSubmit || submitting || hasResult) return;
    setSubmitting(true);
    try {
      const payload = questions.map((q, idx) => {
        const selections = answers[idx] ?? [];
        const typed = (otherText[idx] ?? "").trim();
        // Free-text-only question (no real options): the typed
        // answer is THE answer.
        if (q.freeTextOnly) {
          return typed ? [typed] : [];
        }
        const otherLabel = q.options?.find((opt) =>
          opt.label.toLowerCase().includes("other"),
        )?.label;
        const out: string[] = [];
        let selectedOther = false;
        for (const label of selections) {
          if (otherLabel && label === otherLabel) {
            // "Other" option: use the typed text as the value.
            if (typed) out.push(typed);
            else out.push(label);
            selectedOther = true;
          } else {
            out.push(label);
          }
        }
        // If user typed a custom answer BUT didn't explicitly pick
        // "Other", treat the typed text as an additional free-form
        // answer — this lets the new modal's always-visible
        // textarea work even when there's no "Other" option in
        // the question's option list.
        if (typed && !selectedOther && !out.includes(typed)) {
          out.push(typed);
        }
        return out;
      });
      await onSubmit(item.toolCallId, payload);
    } finally {
      setSubmitting(false);
    }
  };

  // Step-by-step modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  // Auto-open the modal the FIRST time a question lands so the user
  // doesn't have to click. After they close it, they can re-open
  // via the Answer button.
  useEffect(() => {
    if (questions.length > 0 && !hasResult) {
      setModalOpen(true);
      setStepIdx(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.toolCallId]);

  // Reset wizard when modal closes (so re-opening starts fresh
  // visually if the user had been mid-flow).
  useEffect(() => {
    if (!modalOpen) setStepIdx(0);
  }, [modalOpen]);

  // Esc to close
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  const currentQuestion = questions[stepIdx];
  const isFirstStep = stepIdx === 0;
  const isLastStep = stepIdx === questions.length - 1;

  // Per-question completeness (used to gate Next + Submit + answer-pill rendering)
  const stepHasAnswer = useCallback(
    (idx: number) => {
      const q = questions[idx];
      if (!q) return false;
      const selected = answers[idx] ?? [];
      const typed = (otherText[idx] ?? "").trim();
      return selected.length > 0 || typed.length > 0;
    },
    [answers, otherText, questions],
  );

  // Compact inline pill — replaces the previous full-form-in-chat
  // approach. Shows N pending questions and the Answer button.
  const headerLabel =
    questions.length === 1
      ? "1 question for you"
      : `${questions.length} questions for you`;
  return (
    <>
      <div
        id={`chat-item-${item.id}`}
        data-chat-item-id={item.id}
        className="flex justify-start gap-3"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/20">
          <Bot className="h-4 w-4 text-indigo-400" />
        </div>
        <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white/[0.03] border border-white/[0.06] px-4 py-3">
          {questions.length === 0 ? (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
              Failed to render question payload
            </div>
          ) : hasResult ? (
            <div className="flex items-center gap-2 text-sm text-emerald-300">
              <CheckCircle className="h-4 w-4" />
              Answer sent.
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm">
                <p className="font-medium text-white/90">{headerLabel}</p>
                <p className="text-xs text-white/50 mt-0.5 line-clamp-1">
                  {questions[0].question}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-indigo-500/20 text-indigo-200 hover:bg-indigo-500/30 transition-colors px-3 py-1.5 text-sm font-medium"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Answer
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Step-by-step modal. Renders one question at a time with
          predefined option cards PLUS an always-available "or type
          a free-text answer" textarea — so the user can pick a
          listed option OR write a custom reply. Tracks step state
          locally; only `handleSubmit` actually fires the answer
          payload back to the agent. */}
      {modalOpen && mounted && currentQuestion && !hasResult &&
        createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center p-2 sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="question-modal-title"
          >
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
              onClick={() => setModalOpen(false)}
            />
            <div className="relative w-full max-w-2xl max-h-[calc(100vh-1rem)] sm:max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-white/[0.06] bg-[#1a1a1a] p-4 sm:p-5 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
              {/* Header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-indigo-400" />
                  <h3
                    id="question-modal-title"
                    className="text-sm font-medium text-white"
                  >
                    Answer
                  </h3>
                  <span className="text-xs text-white/40 font-mono">
                    {stepIdx + 1} / {questions.length}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="p-1 rounded-md text-white/40 hover:text-white/70 hover:bg-white/[0.04] transition-colors"
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Step indicator dots */}
              {questions.length > 1 && (
                <div className="flex items-center gap-1.5 mb-4">
                  {questions.map((_, i) => {
                    const filled = stepHasAnswer(i);
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setStepIdx(i)}
                        className={cn(
                          "h-1.5 rounded-full transition-all",
                          i === stepIdx
                            ? "w-6 bg-indigo-400"
                            : filled
                              ? "w-1.5 bg-emerald-400"
                              : "w-1.5 bg-white/15 hover:bg-white/30",
                        )}
                        title={`Step ${i + 1}${filled ? " (answered)" : ""}`}
                      />
                    );
                  })}
                </div>
              )}

              {/* Question body */}
              <div className="space-y-3">
                <div>
                  {currentQuestion.header && (
                    <p className="text-[10px] uppercase tracking-wide text-white/40 mb-1">
                      {currentQuestion.header}
                    </p>
                  )}
                  <p className="text-base font-medium text-white/90 leading-relaxed">
                    {currentQuestion.question}
                  </p>
                </div>

                {/* Predefined options (skip when freeTextOnly — that
                    means the only option is "Other"). */}
                {!currentQuestion.freeTextOnly &&
                  (currentQuestion.options?.length ?? 0) > 0 && (
                    <div className="space-y-1.5">
                      {currentQuestion.options
                        ?.filter(
                          (opt) =>
                            !opt.label.toLowerCase().includes("other"),
                        )
                        .map((opt) => {
                          const selected = new Set(answers[stepIdx] ?? []);
                          const checked = selected.has(opt.label);
                          return (
                            <button
                              key={opt.label}
                              type="button"
                              onClick={() =>
                                handleToggle(
                                  stepIdx,
                                  opt.label,
                                  Boolean(currentQuestion.multiple),
                                )
                              }
                              className={cn(
                                "w-full text-left rounded-lg border px-3 py-2.5 transition-colors",
                                checked
                                  ? "border-indigo-500/40 bg-indigo-500/10"
                                  : "border-white/10 hover:border-white/25 hover:bg-white/[0.03]",
                              )}
                            >
                              <div className="flex items-start gap-2">
                                <span
                                  className={cn(
                                    "mt-0.5 h-4 w-4 shrink-0 rounded-full border flex items-center justify-center transition-colors",
                                    checked
                                      ? "border-indigo-400 bg-indigo-500"
                                      : "border-white/30",
                                  )}
                                >
                                  {checked && (
                                    <CheckCircle className="h-2.5 w-2.5 text-white" />
                                  )}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm text-white/90">
                                    {opt.label}
                                  </div>
                                  {opt.description && (
                                    <div className="text-xs text-white/50 mt-0.5 leading-relaxed">
                                      {opt.description}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                    </div>
                  )}

                {/* Free-text response area — always shown so the
                    user can type a custom reply (or override the
                    predefined options entirely). Submitted as the
                    answer when non-empty. */}
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wide text-white/40">
                    {currentQuestion.freeTextOnly
                      ? "Your answer"
                      : "Or type a custom answer"}
                  </label>
                  <textarea
                    value={otherText[stepIdx] ?? ""}
                    onChange={(e) =>
                      setOtherText((prev) => ({
                        ...prev,
                        [stepIdx]: e.target.value,
                      }))
                    }
                    onKeyDown={(e) => {
                      // Cmd/Ctrl+Enter = submit. Plain Enter inserts
                      // a newline (textarea behavior).
                      if (
                        e.key === "Enter" &&
                        (e.metaKey || e.ctrlKey) &&
                        canSubmit &&
                        !submitting
                      ) {
                        e.preventDefault();
                        handleSubmit();
                      }
                    }}
                    placeholder="Type your answer…"
                    disabled={submitting}
                    rows={3}
                    autoFocus={isFirstStep}
                    className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 focus:border-indigo-500/50 focus:outline-none resize-none leading-relaxed"
                  />
                </div>
              </div>

              {/* Nav footer */}
              <div className="mt-5 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setStepIdx(Math.max(0, stepIdx - 1))}
                  disabled={isFirstStep}
                  className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:text-white/90 hover:bg-white/[0.04] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Back
                </button>
                {isLastStep ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await handleSubmit();
                      setModalOpen(false);
                    }}
                    disabled={!canSubmit || submitting}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                      !canSubmit || submitting
                        ? "bg-white/5 text-white/30 cursor-not-allowed"
                        : "bg-indigo-500 text-white hover:bg-indigo-600",
                    )}
                  >
                    {submitting ? "Sending…" : "Submit answer"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      setStepIdx(Math.min(questions.length - 1, stepIdx + 1))
                    }
                    disabled={!stepHasAnswer(stepIdx)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                      !stepHasAnswer(stepIdx)
                        ? "bg-white/5 text-white/30 cursor-not-allowed"
                        : "bg-indigo-500/20 text-indigo-200 hover:bg-indigo-500/30",
                    )}
                  >
                    Next
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function isPendingUserInputTool(item: ChatItem): boolean {
  if (item.kind !== "tool" || item.result !== undefined) return false;
  return (
    item.name === "question" ||
    item.name === "AskUserQuestion" ||
    item.name === "ui_optionList"
  );
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}


function statusLabel(state: ControlRunState): {
  label: string;
  Icon: typeof Loader;
  className: string;
} {
  switch (state) {
    case "idle":
      return { label: "Idle", Icon: Clock, className: "text-white/40" };
    case "running":
      return { label: "Running", Icon: Loader, className: "text-indigo-400" };
    case "waiting_for_tool":
      return { label: "Waiting", Icon: Loader, className: "text-amber-400" };
  }
  return { label: "Idle", Icon: Clock, className: "text-white/40" };
}

function missionStatusLabel(
  status: MissionStatus,
  isRunning = false,
): {
  label: string;
  className: string;
} {
  if (isRunning) {
    return { label: "Running", className: "bg-indigo-500/20 text-indigo-400" };
  }

  switch (status) {
    case "pending":
      return { label: "Pending", className: "bg-zinc-500/20 text-zinc-400" };
    case "active":
      return { label: "Active", className: "bg-indigo-500/20 text-indigo-400" };
    case "awaiting_user":
      return { label: "Needs You", className: "bg-sky-500/20 text-sky-400" };
    case "acknowledged":
      return {
        label: "Acknowledged",
        className: "bg-emerald-500/20 text-emerald-400",
      };
    case "completed":
      return {
        label: "Completed",
        className: "bg-emerald-500/20 text-emerald-400",
      };
    case "failed":
      return { label: "Failed", className: "bg-red-500/20 text-red-400" };
    case "interrupted":
      return {
        label: "Interrupted",
        className: "bg-amber-500/20 text-amber-400",
      };
    case "blocked":
      return {
        label: "Blocked",
        className: "bg-orange-500/20 text-orange-400",
      };
    case "not_feasible":
      return {
        label: "Not Feasible",
        className: "bg-rose-500/20 text-rose-400",
      };
  }
}

function missionStatusDotClass(
  status: MissionStatus,
  isRunning = false,
): string {
  return getMissionDotColor(status, isRunning);
}

// Copy button component
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [, copy] = useCopyToClipboard();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const success = await copy(text);
    if (success) {
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error("Failed to copy");
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "p-1.5 rounded-lg transition-all",
        "opacity-0 group-hover:opacity-100",
        "hover:bg-white/[0.08] text-white/40 hover:text-white/70",
        className,
      )}
      title="Copy message"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-400" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

// Shimmer loading effect
function Shimmer({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse", className)}>
      <div className="h-4 bg-white/[0.06] rounded w-3/4 mb-2" />
      <div className="h-4 bg-white/[0.06] rounded w-1/2 mb-2" />
      <div className="h-4 bg-white/[0.06] rounded w-5/6" />
    </div>
  );
}

function ChatLoadingSkeleton() {
  // Mirrors ChatItemRow: assistant rows are left-aligned with a Bot avatar
  // (h-8 w-8 bg-indigo-500/20), user rows are right-aligned with a User
  // avatar (bg-white/[0.08]) and a solid indigo bubble. Both bubbles use
  // max-w-[80%].
  const rows: Array<"assistant" | "user"> = ["assistant", "user", "assistant"];
  return (
    <div className="mx-auto w-full max-w-4xl xl:max-w-5xl space-y-6 animate-pulse">
      {rows.map((role, idx) => {
        const isAssistant = role === "assistant";
        return (
          <div
            key={idx}
            className={cn(
              "flex gap-3",
              isAssistant ? "justify-start" : "justify-end",
            )}
          >
            {isAssistant && (
              <div className="h-8 w-8 shrink-0 rounded-full bg-indigo-500/20" />
            )}
            <div
              className={cn(
                "max-w-[80%] rounded-2xl px-4 py-3",
                isAssistant
                  ? "rounded-tl-md border border-white/[0.06] bg-white/[0.03]"
                  : "rounded-tr-md bg-indigo-500/70",
              )}
            >
              <div
                className={cn(
                  "h-3 w-48 rounded",
                  isAssistant ? "bg-white/[0.08]" : "bg-white/30",
                )}
              />
              <div
                className={cn(
                  "mt-2 h-3 w-40 rounded",
                  isAssistant ? "bg-white/[0.06]" : "bg-white/20",
                )}
              />
              {isAssistant && (
                <div className="mt-2 h-3 w-32 rounded bg-white/[0.06]" />
              )}
            </div>
            {!isAssistant && (
              <div className="h-8 w-8 shrink-0 rounded-full bg-white/[0.08]" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function isTextPreviewableSharedFile(file: SharedFile): boolean {
  const name = (file.name || "").toLowerCase();
  if (file.content_type.startsWith("text/")) return true;
  if (
    file.content_type.includes("json") ||
    file.content_type.includes("yaml") ||
    file.content_type.includes("xml")
  ) {
    return true;
  }
  return (
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".log") ||
    name.endsWith(".json") ||
    name.endsWith(".yaml") ||
    name.endsWith(".yml") ||
    name.endsWith(".toml") ||
    name.endsWith(".xml") ||
    name.endsWith(".csv") ||
    name.endsWith(".tsv")
  );
}

function getLanguageFromSharedFile(file: SharedFile): string {
  const name = (file.name || "").toLowerCase();
  if (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    file.content_type.includes("markdown")
  )
    return "markdown";
  if (name.endsWith(".json") || file.content_type.includes("json"))
    return "json";
  if (
    name.endsWith(".yaml") ||
    name.endsWith(".yml") ||
    file.content_type.includes("yaml")
  )
    return "yaml";
  if (name.endsWith(".xml") || file.content_type.includes("xml")) return "xml";
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".tsv")) return "tsv";
  return "text";
}

function SharedFilePreviewModal({
  file,
  resolvedUrl,
  isApiUrl,
  onClose,
  onDownload,
}: {
  file: SharedFile;
  resolvedUrl: string;
  isApiUrl: boolean;
  onClose: () => void;
  onDownload: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);

  const language = useMemo(() => getLanguageFromSharedFile(file), [file]);
  const isMarkdown = language === "markdown";

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      setText("");
      setSizeBytes(null);
      try {
        const res = await fetch(resolvedUrl, {
          headers: isApiUrl ? { ...authHeader() } : undefined,
        });
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        const blob = await res.blob();
        const raw = await blob.text();
        const limit = 500_000;
        const finalText =
          raw.length > limit
            ? `${raw.slice(0, limit)}\n\n... (file truncated, too large to preview)`
            : raw;
        if (!cancelled) {
          setSizeBytes(blob.size);
          setText(finalText);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isApiUrl, resolvedUrl]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore.
    }
  }, [text]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm pointer-events-none" />
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "relative rounded-2xl bg-[#1a1a1a] border border-white/[0.06] shadow-xl w-full max-w-4xl",
          "animate-in fade-in zoom-in-95 duration-200",
        )}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white truncate">
              {file.name}
            </h3>
            <p className="text-xs text-white/40 truncate">
              {file.content_type}
              {sizeBytes != null && (
                <span className="ml-2">• {formatBytes(sizeBytes)}</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-3">
            {!loading && !error && text && (
              <button
                onClick={handleCopy}
                className="p-1.5 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.08] transition-colors"
                title={copied ? "Copied" : "Copy"}
              >
                {copied ? (
                  <Check className="h-4 w-4 text-emerald-400" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            )}
            <button
              onClick={onDownload}
              className="p-1.5 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.08] transition-colors"
              title="Download"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.08] transition-colors"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="max-h-[70vh] overflow-auto">
          {loading ? (
            <div className="p-5">
              <Shimmer />
            </div>
          ) : error ? (
            <div className="p-5 text-sm text-red-400">{error}</div>
          ) : isMarkdown ? (
            <div className="p-5">
              <MarkdownContent content={text} />
            </div>
          ) : (
            <div className="text-sm">
              <LazyCodeBlock
                language={language}
                showLineNumbers
                customStyle={{
                  padding: "1rem",
                  background: "transparent",
                  fontSize: "0.8125rem",
                }}
              >
                {text}
              </LazyCodeBlock>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Shared file card component - renders images inline and other files as download cards
function SharedFileCard({ file }: { file: SharedFile }) {
  const iconMap: Record<SharedFile["kind"], typeof File> = {
    image: ImageIcon,
    document: FileText,
    archive: FileArchive,
    code: Code,
    other: File,
  };
  const FileIcon = iconMap[file.kind] || File;

  // Format file size
  const sizeLabel = file.size_bytes ? formatBytes(file.size_bytes) : null;

  const apiBase = getRuntimeApiBase();
  const isApiRelativeUrl = file.url.startsWith("/");
  const isApiUrl = isApiRelativeUrl || file.url.startsWith(apiBase);
  const resolvedUrl = isApiRelativeUrl ? `${apiBase}${file.url}` : file.url;
  const canPreview = isTextPreviewableSharedFile(file);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // If this is an API-protected image, fetch it with auth and render from an object URL.
  useEffect(() => {
    if (file.kind !== "image") return;
    if (!isApiUrl) return; // External URLs can be loaded directly by the browser.

    let cancelled = false;
    let localUrl: string | null = null;

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(resolvedUrl, { headers: { ...authHeader() } });
        if (!res.ok) throw new Error(`Failed to load image (${res.status})`);
        const blob = await res.blob();
        localUrl = URL.createObjectURL(blob);
        if (!cancelled) setBlobUrl(localUrl);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [file.kind, isApiUrl, resolvedUrl]);

  const handleDownload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // If URL is external, let the browser handle it.
      if (!isApiUrl) {
        window.open(resolvedUrl, "_blank", "noopener,noreferrer");
        return;
      }

      const res = await fetch(resolvedUrl, { headers: { ...authHeader() } });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name || "download";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [file.name, isApiUrl, resolvedUrl]);

  const handleOpen = useCallback(() => {
    if (file.kind === "image" && blobUrl) {
      window.open(blobUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (!isApiUrl) {
      window.open(resolvedUrl, "_blank", "noopener,noreferrer");
      return;
    }
    // For API URLs we can't open directly without headers; download instead.
    void handleDownload();
  }, [blobUrl, file.kind, handleDownload, isApiUrl, resolvedUrl]);

  if (file.kind === "image") {
    // Render images inline (supports auth-protected API URLs).
    return (
      <div className="mt-3 rounded-lg overflow-hidden border border-white/[0.06] bg-black/20">
        <button
          type="button"
          onClick={handleOpen}
          className="block w-full text-left"
        >
          {loading && !blobUrl ? (
            <div className="h-[240px] w-full animate-pulse bg-white/[0.03]" />
          ) : (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={blobUrl || resolvedUrl}
                alt={file.name}
                className="max-w-full max-h-[400px] object-contain"
                loading="lazy"
              />
            </>
          )}
        </button>
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-white/40 border-t border-white/[0.06]">
          <ImageIcon aria-hidden="true" className="h-3 w-3" />
          <span className="truncate flex-1">{file.name}</span>
          {sizeLabel && <span>{sizeLabel}</span>}
          <button
            type="button"
            onClick={handleOpen}
            className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
            title="Open"
            aria-label="Open"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
            title="Download"
            aria-label="Download"
            disabled={loading}
          >
            <Download className={cn("h-3 w-3", loading && "animate-pulse")} />
          </button>
        </div>
        {error && <div className="px-3 pb-2 text-xs text-red-400">{error}</div>}
      </div>
    );
  }

  // Render other files as cards (download always, preview for text/markdown)
  return (
    <>
      <div
        className={cn(
          "mt-3 flex items-center gap-3 px-4 py-3 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] transition-colors group",
          canPreview && "cursor-pointer",
        )}
        onClick={() => {
          if (canPreview) setPreviewOpen(true);
        }}
        role={canPreview ? "button" : undefined}
        tabIndex={canPreview ? 0 : undefined}
        onKeyDown={(e) => {
          if (!canPreview) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setPreviewOpen(true);
          }
        }}
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10">
          <FileIcon className="h-5 w-5 text-indigo-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-white/80 truncate">
            {file.name}
          </div>
          <div className="text-xs text-white/40 flex items-center gap-2">
            <span className="truncate">{file.content_type}</span>
            {sizeLabel && (
              <>
                <span>•</span>
                <span>{sizeLabel}</span>
              </>
            )}
          </div>
          {error && <div className="mt-1 text-xs text-red-400">{error}</div>}
        </div>

        {canPreview && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPreviewOpen(true);
            }}
            className="p-2 rounded-md text-white/30 group-hover:text-indigo-400 hover:bg-white/[0.06] transition-colors"
            title="Preview"
            aria-label="Preview"
            disabled={loading}
          >
            <Eye className={cn("h-4 w-4", loading && "animate-pulse")} />
          </button>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleDownload();
          }}
          className="p-2 rounded-md text-white/30 group-hover:text-indigo-400 hover:bg-white/[0.06] transition-colors"
          title="Download"
          aria-label="Download"
          disabled={loading}
        >
          <Download className={cn("h-4 w-4", loading && "animate-pulse")} />
        </button>
      </div>

      {previewOpen && canPreview && (
        <SharedFilePreviewModal
          file={file}
          resolvedUrl={resolvedUrl}
          isApiUrl={isApiUrl}
          onClose={() => setPreviewOpen(false)}
          onDownload={() => void handleDownload()}
        />
      )}
    </>
  );
}

// Phase indicator - shows what the agent is doing during preparation
function PhaseItem({ item }: { item: Extract<ChatItem, { kind: "phase" }> }) {
  const phaseLabels: Record<string, { label: string; icon: typeof Brain }> = {
    estimating_complexity: { label: "Analyzing task", icon: Brain },
    selecting_model: { label: "Selecting model", icon: Cpu },
    splitting_task: { label: "Decomposing task", icon: Target },
    executing: { label: "Executing", icon: Loader },
    verifying: { label: "Verifying", icon: CheckCircle },
  };

  const { label, icon: Icon } = phaseLabels[item.phase] ?? {
    label: item.phase.replace(/_/g, " "),
    icon: Brain,
  };

  return (
    <div className="flex items-center gap-3 py-3 animate-fade-in">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10">
        <Icon className="h-4 w-4 text-indigo-400 animate-pulse" />
      </div>
      <div className="flex flex-col">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-indigo-400">{label}</span>
          {item.agent && (
            <span className="text-[10px] font-mono text-white/30 bg-white/[0.04] px-1.5 py-0.5 rounded">
              {item.agent}
            </span>
          )}
        </div>
        {item.detail && (
          <span className="text-xs text-white/40">{item.detail}</span>
        )}
      </div>
      <div className="ml-auto">
        <Loader className="h-3 w-3 text-indigo-400/50 animate-spin" />
      </div>
    </div>
  );
}

// Thinking group component - displays multiple thinking items merged with separators
function ThinkingGroupItem({
  items,
  basePath,
  workspaceId,
  missionId,
}: {
  items: SidePanelItem[];
  basePath?: string;
  workspaceId?: string;
  missionId?: string;
}) {
  // Filter out empty items for display
  const nonEmptyItems = useMemo(
    () => items.filter((item) => item.content.trim()),
    [items],
  );

  const hasActiveItem = items.some((item) => !item.done);
  // Default-open: thinking is short and worth scanning per turn.
  // Streaming (text drafts) is noisy — the agent re-emits each
  // delta, so a long turn spawns many "Draft" rows that scroll
  // the chat. Collapse stream-only groups by default; keep
  // anything containing actual thinking open.
  const streamOnly = useMemo(
    () =>
      nonEmptyItems.length > 0 &&
      nonEmptyItems.every((item) => item.kind === "stream"),
    [nonEmptyItems],
  );
  const [expanded, setExpanded] = useState(!streamOnly);

  // Get the earliest start time and latest end time
  const startTime = Math.min(...items.map((item) => item.startTime));
  const endTime = items.every((item) => item.done && item.endTime)
    ? Math.max(...items.map((item) => item.endTime || item.startTime))
    : undefined;

  // (Auto-collapse on completion removed — see expanded default above.)

  // Only the active branch ticks once per second via `<LiveDuration>`.
  // When the group is fully done, we render a fixed string and never
  // subscribe to `useNow()`.
  const doneDuration =
    !hasActiveItem && endTime
      ? formatDuration(Math.floor((endTime - startTime) / 1000))
      : null;

  // If no non-empty items, don't render anything
  if (nonEmptyItems.length === 0) {
    return null;
  }

  const label = (() => {
    const hasStream = nonEmptyItems.some((item) => item.kind === "stream");
    const hasThinking = nonEmptyItems.some((item) => item.kind === "thinking");
    if (hasStream && !hasThinking) {
      return nonEmptyItems.length === 1 ? "Draft" : "Drafts";
    }
    return nonEmptyItems.length === 1 ? "Thought" : "Thoughts";
  })();

  const activeLabel = (() => {
    if (items.some((item) => !item.done && item.kind === "thinking")) {
      return "Thinking";
    }
    if (items.some((item) => !item.done && item.kind === "stream")) {
      return "Streaming";
    }
    return "Thinking";
  })();

  return (
    <div className="my-2">
      {/* Compact header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-full",
          "bg-white/[0.04] border border-white/[0.06]",
          "text-white/40 hover:text-white/60 hover:bg-white/[0.06]",
          "transition-all duration-200",
        )}
      >
        <Brain
          className={cn(
            "h-3 w-3",
            hasActiveItem && "animate-pulse text-indigo-400",
          )}
        />
        <span className="text-xs">
          {hasActiveItem ? (
            <>
              {activeLabel} for <LiveDuration startTime={startTime} />
            </>
          ) : (
            `${label} for ${doneDuration ?? "<1s"}`
          )}
        </span>
        {nonEmptyItems.length > 1 && (
          <span className="text-xs text-white/30">
            ({nonEmptyItems.length})
          </span>
        )}
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform duration-200",
            expanded ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>

      {/* Expandable content — no max-height cap and no inner
          scroll container, so the full thought text flows in the
          main chat instead of being clipped into a small box. The
          fade transition stays so collapse/expand still animates. */}
      <div
        className={cn(
          "transition-opacity duration-200 ease-out",
          expanded ? "opacity-100 mt-2" : "hidden opacity-0",
        )}
      >
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="leading-relaxed space-y-2">
            {nonEmptyItems.map((item, idx) => (
              <div key={item.id}>
                {idx > 0 && (
                  <div className="border-t border-white/[0.06] my-2" />
                )}
                {/* Use StreamingMarkdown for efficient incremental rendering */}
                <StreamingMarkdown
                  content={item.content}
                  isStreaming={!item.done}
                  className="text-sm leading-relaxed text-white/70 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5"
                  basePath={basePath}
                  workspaceId={workspaceId}
                  missionId={missionId}
                />
              </div>
            ))}
            {hasActiveItem && nonEmptyItems.length === 0 && (
              <span className="italic text-white/30">Processing...</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


// Live pod-boot progress for the K8sPod backend. The control plane
// emits a `mission_pod_startup` event for every phase transition while
// the mission's per-mission Pod boots (PVC bind -> image pull ->
// container start -> init -> ready). The banner stays visible until
// the mission flips out of `pending`.
const POD_PHASE_LABELS: Record<string, string> = {
  pvc_binding: "Binding storage",
  pod_scheduled: "Scheduled",
  pulling: "Pulling image",
  pulled: "Image pulled",
  container_starting: "Starting container",
  container_ready: "Container ready",
  init_script_running: "Running init script",
  ready: "Ready",
  error: "Error",
};

function PodStartupBanner({
  phase,
  message,
}: {
  phase: string;
  message: string | null;
}) {
  const isError = phase === "error";
  const label = POD_PHASE_LABELS[phase] ?? phase;
  return (
    <section className="space-y-2">
      <p className="text-[10px] uppercase tracking-wide text-white/30">
        Workspace pod
      </p>
      <div
        className={cn(
          "flex items-start gap-2 rounded-md border p-2 text-xs",
          isError
            ? "border-red-500/30 bg-red-500/10 text-red-200"
            : "border-indigo-500/20 bg-indigo-500/10 text-indigo-100",
        )}
      >
        {isError ? (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <Loader className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug">{label}</p>
          {message && (
            <p
              className={cn(
                "mt-0.5 break-words leading-snug",
                isError ? "text-red-200/80" : "text-white/60",
              )}
            >
              {message}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

// Color family per service state. The backend ships docker's raw
// state ("running", "created", "exited", …) and the compose health
// string ("healthy", "starting", "unhealthy", "none"). Map both into
// one of four UI buckets so the row dot is unambiguous at a glance.
type DockerServiceTone = "green" | "orange" | "red" | "gray";

function dockerServiceTone(service: {
  state: string;
  health: string;
}): DockerServiceTone {
  const s = service.state.toLowerCase();
  const h = service.health.toLowerCase();
  if (h === "unhealthy") return "red";
  if (s === "exited" || s === "dead") return "red";
  if (s === "running" && (h === "healthy" || h === "none")) return "green";
  if (s === "running" && h === "starting") return "orange";
  if (s === "restarting" || s === "paused" || s === "removing") return "orange";
  if (s === "created") return "gray";
  return "gray";
}

function DockerServicesPanel({
  services,
}: {
  services: import("@/lib/api").DockerServiceStatus[];
}) {
  if (services.length === 0) return null;
  const sorted = [...services].sort((a, b) => a.service.localeCompare(b.service));
  const counts = { green: 0, orange: 0, red: 0, gray: 0 } as Record<
    DockerServiceTone,
    number
  >;
  for (const s of sorted) counts[dockerServiceTone(s)] += 1;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wide text-white/30">
          Docker services
        </p>
        <div className="flex items-center gap-2 text-[10px]">
          {counts.green > 0 && (
            <span className="flex items-center gap-1 text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {counts.green}
            </span>
          )}
          {counts.orange > 0 && (
            <span className="flex items-center gap-1 text-amber-400">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              {counts.orange}
            </span>
          )}
          {counts.red > 0 && (
            <span className="flex items-center gap-1 text-red-400">
              <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
              {counts.red}
            </span>
          )}
          {counts.gray > 0 && (
            <span className="flex items-center gap-1 text-white/40">
              <span className="h-1.5 w-1.5 rounded-full bg-white/30 animate-pulse" />
              {counts.gray}
            </span>
          )}
        </div>
      </div>
      <ul className="space-y-1 rounded-md border border-white/[0.05] bg-white/[0.02] p-2 max-h-64 overflow-y-auto">
        {sorted.map((s) => {
          const tone = dockerServiceTone(s);
          const toneCls =
            tone === "green"
              ? "bg-emerald-400"
              : tone === "orange"
                ? "bg-amber-400 animate-pulse"
                : tone === "red"
                  ? "bg-red-400"
                  : "bg-white/40 animate-pulse";
          return (
            <li
              key={s.container_id || s.service}
              className="flex items-center gap-2 text-xs"
              title={`${s.status}\n${s.image}`}
            >
              <span className={cn("h-2 w-2 rounded-full shrink-0", toneCls)} />
              <span className="font-mono text-white/80 truncate flex-1">
                {s.service}
              </span>
              <span className="text-[10px] text-white/40 truncate max-w-[100px]">
                {s.health !== "none" ? s.health : s.state}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Strip of clickable tabs above the chat: "Main thread" + one
// tab per Agent tool call. Switches the chat view scope below.
function SubagentTabStrip({
  subagents,
  activeTab,
  onSelect,
}: {
  subagents: Array<{
    id: string;
    toolCallId: string;
    name: string;
    args: unknown;
    result?: unknown;
  }>;
  activeTab: string | null;
  onSelect: (tab: string | null) => void;
}) {
  // If the currently-focused sub-agent just completed and dropped
  // out of the running list, snap back to Main thread so the user
  // isn't stuck on a tab that has nothing to render.
  useEffect(() => {
    if (
      activeTab &&
      !subagents.some((s) => s.toolCallId === activeTab)
    ) {
      onSelect(null);
    }
  }, [activeTab, subagents, onSelect]);

  const labelOf = (args: unknown): string => {
    if (args && typeof args === "object") {
      const obj = args as Record<string, unknown>;
      for (const k of ["description", "subagent_type", "agent", "name"]) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
    return "Sub-agent";
  };
  return (
    <div className="flex items-center gap-1.5 px-4 py-2 border-b border-white/[0.06] bg-white/[0.01] overflow-x-auto overflow-y-hidden whitespace-nowrap">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "shrink-0 px-2.5 py-1 rounded-full text-xs font-medium transition-colors",
          activeTab === null
            ? "bg-indigo-500/20 text-indigo-200 border border-indigo-500/40"
            : "text-white/50 hover:text-white/80 hover:bg-white/[0.04] border border-transparent",
        )}
      >
        Main thread
      </button>
      <div className="h-4 w-px bg-white/[0.06] mx-0.5" />
      {subagents.map((s) => {
        const done = s.result !== undefined;
        const active = activeTab === s.toolCallId;
        const tone = done ? "bg-emerald-400" : "bg-amber-400 animate-pulse";
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.toolCallId)}
            className={cn(
              "shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-colors",
              active
                ? "bg-violet-500/20 text-violet-200 border border-violet-500/40"
                : "text-white/50 hover:text-white/80 hover:bg-white/[0.04] border border-transparent",
            )}
            title={labelOf(s.args)}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", tone)} />
            <span className="truncate max-w-[180px]">{labelOf(s.args)}</span>
          </button>
        );
      })}
    </div>
  );
}

// Chat-like view of one sub-agent's scoped activity. Shows the
// spawn prompt, every tool call the sub-agent ran, and any
// streamed text — all read-only (Claude Code's `Agent` tool is
// single-shot, no follow-up channel exists).
function SubagentChatView({
  subagent,
  activity,
}: {
  subagent: {
    id: string;
    toolCallId: string;
    name: string;
    args: unknown;
    result?: unknown;
  };
  activity: Array<
    | {
        kind: "tool_call";
        tool_call_id: string;
        name: string;
        args: unknown;
        ts: number;
      }
    | {
        kind: "tool_result";
        tool_call_id: string;
        name: string;
        result: unknown;
        ts: number;
      }
    | { kind: "text"; content: string; ts: number }
  >;
}) {
  const description =
    subagent.args && typeof subagent.args === "object"
      ? (
          (subagent.args as Record<string, unknown>).description as
            | string
            | undefined
        ) ?? null
      : null;
  const prompt =
    subagent.args && typeof subagent.args === "object"
      ? ((subagent.args as Record<string, unknown>).prompt as
          | string
          | undefined) ?? null
      : null;
  const isDone = subagent.result !== undefined;
  // Pair tool_call + tool_result by tool_call_id so we render each
  // sub-agent action as a single card.
  type Pair = {
    call: Extract<(typeof activity)[number], { kind: "tool_call" }>;
    result?: Extract<(typeof activity)[number], { kind: "tool_result" }>;
  };
  const pairsAndText: Array<
    Pair | Extract<(typeof activity)[number], { kind: "text" }>
  > = [];
  for (const item of activity) {
    if (item.kind === "tool_call") {
      pairsAndText.push({ call: item });
    } else if (item.kind === "tool_result") {
      // Match back to the most recent matching tool_call.
      for (let i = pairsAndText.length - 1; i >= 0; i--) {
        const p = pairsAndText[i];
        if (
          p &&
          "call" in p &&
          p.call.tool_call_id === item.tool_call_id &&
          !p.result
        ) {
          p.result = item;
          break;
        }
      }
    } else {
      pairsAndText.push(item);
    }
  }

  // Parse the final answer from subagent.result (it's the Agent
  // tool_use's tool_result content, shaped like `{ content: "..." }`).
  let finalAnswer: string | null = null;
  if (subagent.result && typeof subagent.result === "object") {
    const r = subagent.result as Record<string, unknown>;
    if (typeof r.content === "string") finalAnswer = r.content;
  } else if (typeof subagent.result === "string") {
    finalAnswer = subagent.result;
  }

  return (
    <div className="space-y-3 max-w-3xl mx-auto">
      {/* Read-only banner */}
      <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/80 flex items-start gap-2">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Background sub-agents are single-shot. The composer is disabled here
          — add follow-up instructions in the <strong>Main thread</strong> tab
          instead.
        </span>
      </div>

      {/* Spawn prompt as a "user message" bubble */}
      {(description || prompt) && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
          {description && (
            <p className="text-xs font-medium text-white/70">{description}</p>
          )}
          {prompt && (
            <pre className="text-xs text-white/60 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">
              {prompt}
            </pre>
          )}
        </div>
      )}

      {/* Live activity */}
      {pairsAndText.length === 0 && !isDone && (
        <div className="flex items-center gap-2 text-xs text-white/40">
          <Loader className="h-3 w-3 animate-spin" />
          Sub-agent is starting…
        </div>
      )}
      {pairsAndText.map((entry, i) => {
        if ("kind" in entry && entry.kind === "text") {
          return (
            <div
              key={`text-${i}`}
              className="rounded-md border border-white/[0.04] bg-white/[0.01] p-2 text-xs text-white/70 whitespace-pre-wrap leading-relaxed"
            >
              {entry.content}
            </div>
          );
        }
        const pair = entry as Pair;
        const callArgs = pair.call.args;
        const resultStr = pair.result
          ? formatToolResultForDisplay(pair.result.result).slice(0, 1200)
          : null;
        return (
          <div
            key={pair.call.tool_call_id}
            className={cn(
              "rounded-md border bg-white/[0.02] overflow-hidden",
              pair.result ? "border-emerald-500/20" : "border-purple-500/30",
            )}
          >
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
              {pair.result ? (
                <CheckCircle className="h-3 w-3 text-emerald-400" />
              ) : (
                <Loader className="h-3 w-3 text-purple-300 animate-spin" />
              )}
              <span className="font-mono font-medium text-white/80">
                {pair.call.name}
              </span>
              <span className="text-white/30 truncate">
                {(() => {
                  if (callArgs && typeof callArgs === "object") {
                    const obj = callArgs as Record<string, unknown>;
                    for (const k of [
                      "command",
                      "file_path",
                      "pattern",
                      "query",
                      "description",
                    ]) {
                      const v = obj[k];
                      if (typeof v === "string") return v.slice(0, 120);
                    }
                  }
                  return "";
                })()}
              </span>
            </div>
            {resultStr && (
              <pre className="text-[11px] text-white/50 bg-black/20 px-3 py-2 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
                {resultStr}
              </pre>
            )}
          </div>
        );
      })}

      {/* Final answer when complete */}
      {finalAnswer && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-2">
          <p className="text-[10px] uppercase tracking-wide text-emerald-300/70">
            Final answer
          </p>
          <div className="text-sm text-white/85 whitespace-pre-wrap leading-relaxed">
            {finalAnswer}
          </div>
        </div>
      )}
    </div>
  );
}

interface MissionUsageStats {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  latestInput: number;
  latestModel: string | null;
  assistantTurns: number;
}

/**
 * Heuristic mapping of model id → context window in tokens.
 *
 * Used for the workbench progress gauge so "% of memory left" is
 * meaningful per model. The `[1m]` suffix is Anthropic's 1M-token
 * context variant for older models. Opus 4.7+, Opus 4.8, and
 * Sonnet 4.6 ship with a 1M window natively — no suffix required.
 * We default to the 200K Sonnet/Opus baseline when the model is
 * unknown — better to under-report headroom than fabricate it.
 */
function modelContextWindow(model: string | null): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  if (m.includes("[1m]")) return 1_000_000;
  if (
    m.includes("opus-4-7") ||
    m.includes("opus-4-8") ||
    m.includes("sonnet-4-6")
  ) {
    return 1_000_000;
  }
  if (m.includes("opus") || m.includes("sonnet") || m.includes("haiku")) {
    return 200_000;
  }
  if (m.includes("gpt-4.1") || m.includes("gpt-4o") || m.includes("gpt-5")) {
    return 128_000;
  }
  if (m.includes("grok") || m.includes("xai")) return 131_072;
  return 200_000;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return n.toString();
}

function CircleGauge({
  value,
  max,
  label,
  centerLabel,
  tone,
}: {
  value: number;
  max: number;
  label: string;
  centerLabel: string;
  tone: "indigo" | "violet" | "emerald" | "amber" | "rose";
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);
  const stroke =
    tone === "indigo"
      ? "rgb(129 140 248)"
      : tone === "violet"
        ? "rgb(167 139 250)"
        : tone === "emerald"
          ? "rgb(52 211 153)"
          : tone === "amber"
            ? "rgb(251 191 36)"
            : "rgb(251 113 133)";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <svg width={60} height={60} viewBox="0 0 60 60" aria-hidden="true">
        <circle
          cx={30}
          cy={30}
          r={radius}
          stroke="rgba(255,255,255,0.07)"
          strokeWidth={5}
          fill="none"
        />
        <circle
          cx={30}
          cy={30}
          r={radius}
          stroke={stroke}
          strokeWidth={5}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 30 30)"
          style={{ transition: "stroke-dashoffset 400ms ease" }}
        />
        <text
          x={30}
          y={32}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={12}
          fontWeight={600}
          fill="rgba(255,255,255,0.92)"
        >
          {centerLabel}
        </text>
      </svg>
      <span className="text-[10px] uppercase tracking-wide text-white/40">
        {label}
      </span>
    </div>
  );
}

function MissionWorkbenchPanel({
  mission,
  workspaceLabel,
  role,
  isRunning,
  onClose,
  onResume,
  onCancel,
  onOpenAutomations,
  onOpenSwitcher,
  onViewMission,
  onSetStatus,
  runSettingsSlot,
  dockerServices,
  usage,
  className,
}: {
  mission: Mission | null;
  workspaceLabel?: string;
  role: ReturnType<typeof inferMissionRole>;
  isRunning: boolean;
  onClose: () => void;
  onResume: () => void;
  onCancel: (missionId: string) => void;
  onOpenAutomations: () => void;
  onOpenSwitcher: () => void;
  onViewMission: (missionId: string) => void;
  onSetStatus: (status: MissionStatus) => void | Promise<void>;
  /**
   * Optional slot for the mission's run-settings editor (the
   * `<NewMissionDialog mode="edit">` trigger). Rendered next to Resume/Stop
   * so it's accessible without a separate toolbar button.
   */
  runSettingsSlot?: React.ReactNode;
  /** Live docker-compose service state for the per-mission pod (only
   *  populated for K8sPod missions whose initial_repos brought up a
   *  compose stack). Empty / undefined hides the panel. */
  dockerServices?: import("@/lib/api").DockerServiceStatus[];
  /** Token usage stats aggregated from this mission's
   *  assistant_message events. Hidden until at least one turn
   *  reports usage. */
  usage?: MissionUsageStats;
  className?: string;
}) {
  const title =
    mission?.title?.trim() ||
    (mission ? getMissionShortName(mission.id) : "No mission selected");
  const status = mission ? missionStatusLabel(mission.status, isRunning) : null;
  const canResume =
    mission &&
    !isRunning &&
    mission.resumable &&
    (mission.status === "interrupted" ||
      mission.status === "blocked" ||
      mission.status === "failed");

  const [markAsOpen, setMarkAsOpen] = useState(false);
  const markAsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!markAsOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (
        markAsRef.current &&
        !markAsRef.current.contains(event.target as Node)
      ) {
        setMarkAsOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMarkAsOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [markAsOpen]);

  useEffect(() => {
    setMarkAsOpen(false);
  }, [mission?.id]);

  return (
    <aside
      className={cn(
        "w-full h-full flex flex-col rounded-2xl glass-panel border border-white/[0.06] overflow-hidden animate-slide-in-right",
        className,
      )}
      aria-label="Mission workbench"
    >
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <BriefcaseBusiness className="h-4 w-4 shrink-0 text-indigo-400" />
          <span className="truncate text-sm font-medium text-white">
            Workbench
          </span>
        </div>
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-lg text-white/40 hover:bg-white/[0.04] hover:text-white transition-colors"
          title="Close workbench"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
        {!mission ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <Inbox className="mb-3 h-8 w-8 text-white/20" />
            <p className="text-sm text-white/40">
              Select a mission to inspect.
            </p>
            <button
              onClick={onOpenSwitcher}
              className="mt-4 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-white/70 hover:bg-white/[0.04]"
            >
              Open mission switcher
            </button>
          </div>
        ) : (
          <>
            <section className="space-y-3">
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-white/30">
                  Mission
                </p>
                <h2
                  className="line-clamp-3 text-sm font-medium leading-snug text-white/85"
                  title={title}
                >
                  {title}
                </h2>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-white/[0.05] bg-white/[0.02] p-2">
                  <p className="text-[10px] text-white/30">Status</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        missionStatusDotClass(mission.status, isRunning),
                      )}
                    />
                    <span
                      className={cn("text-xs font-medium", status?.className)}
                    >
                      {status?.label}
                    </span>
                  </div>
                </div>
                <div className="rounded-md border border-white/[0.05] bg-white/[0.02] p-2">
                  <p className="text-[10px] text-white/30">Role</p>
                  <p className="mt-1 truncate text-xs font-medium capitalize text-white/70">
                    {role ?? "mission"}
                  </p>
                </div>
                <div className="rounded-md border border-white/[0.05] bg-white/[0.02] p-2">
                  <p className="text-[10px] text-white/30">Workspace</p>
                  <p
                    className="mt-1 truncate text-xs font-medium text-white/70"
                    title={workspaceLabel}
                  >
                    {workspaceLabel ?? "Unassigned"}
                  </p>
                </div>
                <div className="rounded-md border border-white/[0.05] bg-white/[0.02] p-2">
                  <p className="text-[10px] text-white/30">Updated</p>
                  <RelativeTime
                    date={mission.updated_at}
                    className="mt-1 text-xs font-medium text-white/70"
                  />
                </div>
              </div>
              {mission.short_description && (
                <p className="rounded-md border border-white/[0.05] bg-white/[0.02] p-2 text-xs leading-relaxed text-white/50">
                  {mission.short_description}
                </p>
              )}
            </section>

            {mission.status === "pending" && mission.pod_phase && (
              <PodStartupBanner
                phase={mission.pod_phase}
                message={mission.pod_message ?? null}
              />
            )}

            {dockerServices && dockerServices.length > 0 && (
              <DockerServicesPanel services={dockerServices} />
            )}

            {/* Token usage gauges. The "Context" gauge is the input
                side of the most recent turn (raw + cache_read +
                cache_creation) as a fraction of the model's context
                window — i.e. how much memory the agent currently
                has left. "Output" is cumulative output tokens for
                the whole mission, scaled against an arbitrary 100k
                soft cap (purely visual; the real spend is in
                Stats). Hidden until at least one assistant turn
                reports usage. */}
            {usage && usage.assistantTurns > 0 && (
              <section className="space-y-2">
                <p className="text-[10px] uppercase tracking-wide text-white/30">
                  Token usage
                </p>
                <div className="rounded-md border border-white/[0.05] bg-white/[0.02] p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <CircleGauge
                      value={usage.latestInput}
                      max={modelContextWindow(usage.latestModel)}
                      label="Context"
                      centerLabel={`${Math.min(
                        100,
                        Math.round(
                          (usage.latestInput /
                            modelContextWindow(usage.latestModel)) *
                            100,
                        ),
                      )}%`}
                      tone={
                        usage.latestInput /
                          modelContextWindow(usage.latestModel) >
                        0.85
                          ? "rose"
                          : usage.latestInput /
                                modelContextWindow(usage.latestModel) >
                              0.6
                            ? "amber"
                            : "indigo"
                      }
                    />
                    <CircleGauge
                      value={usage.totalOutput}
                      max={100_000}
                      label="Output"
                      centerLabel={formatTokenCount(usage.totalOutput)}
                      tone="emerald"
                    />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                    <div className="flex items-center justify-between">
                      <span className="text-white/40">Memory left</span>
                      <span className="font-mono text-white/80">
                        {formatTokenCount(
                          Math.max(
                            0,
                            modelContextWindow(usage.latestModel) -
                              usage.latestInput,
                          ),
                        )}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-white/40">Turns</span>
                      <span className="font-mono text-white/80">
                        {usage.assistantTurns}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-white/40">Cache hit</span>
                      <span className="font-mono text-white/80">
                        {usage.totalCacheRead +
                          usage.totalCacheCreate +
                          usage.totalInput >
                        0
                          ? `${Math.round(
                              (usage.totalCacheRead /
                                Math.max(
                                  1,
                                  usage.totalCacheRead +
                                    usage.totalCacheCreate +
                                    usage.totalInput,
                                )) *
                                100,
                            )}%`
                          : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-white/40">Window</span>
                      <span className="font-mono text-white/80">
                        {formatTokenCount(
                          modelContextWindow(usage.latestModel),
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Agent Tasks moved to its own right-column panel — see
                AgentTasksPanel render in the right-column stack. */}

            <section className="space-y-2">
              <p className="text-[10px] uppercase tracking-wide text-white/30">
                Actions
              </p>
              <div className="grid grid-cols-2 gap-2">
                {canResume && (
                  <button
                    onClick={onResume}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/15"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Resume
                  </button>
                )}
                {isRunning && (
                  <button
                    onClick={() => onCancel(mission.id)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-500/15"
                  >
                    <Square className="h-3.5 w-3.5" />
                    Stop
                  </button>
                )}
                <button
                  onClick={onOpenAutomations}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs font-medium text-white/70 hover:bg-white/[0.04]"
                >
                  <Clock className="h-3.5 w-3.5" />
                  Automations
                </button>
                <button
                  onClick={onOpenSwitcher}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs font-medium text-white/70 hover:bg-white/[0.04]"
                >
                  <Layers className="h-3.5 w-3.5" />
                  Switch
                </button>
                <div ref={markAsRef} className="relative">
                  <button
                    onClick={() => setMarkAsOpen((prev) => !prev)}
                    aria-haspopup="menu"
                    aria-expanded={markAsOpen}
                    className={cn(
                      "inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs font-medium text-white/70 hover:bg-white/[0.04]",
                      markAsOpen && "bg-white/[0.06] text-white",
                    )}
                  >
                    <Flag className="h-3.5 w-3.5" />
                    Mark As
                  </button>
                  {markAsOpen && (
                    <div
                      role="menu"
                      className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-white/[0.08] bg-[#1a1a1a] shadow-xl"
                    >
                      {(
                        ["completed", "blocked", "failed"] as MissionStatus[]
                      ).map((nextStatus) => (
                        <AsyncButton
                          key={nextStatus}
                          role="menuitem"
                          onClick={async () => {
                            try {
                              await onSetStatus(nextStatus);
                            } finally {
                              setMarkAsOpen(false);
                            }
                          }}
                          disabled={mission.status === nextStatus}
                          spinnerClassName="h-3 w-3"
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs capitalize text-white/70 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          <span>{nextStatus.replace("_", " ")}</span>
                          {mission.status === nextStatus && (
                            <CheckCircle className="h-3 w-3 text-white/40" />
                          )}
                        </AsyncButton>
                      ))}
                    </div>
                  )}
                </div>
                {runSettingsSlot && (
                  <div className="col-span-2 [&>div]:w-full [&>div>button]:w-full [&>div>button]:justify-center">
                    {runSettingsSlot}
                  </div>
                )}
              </div>
            </section>

          </>
        )}
      </div>
    </aside>
  );
}

// Get icon for tool based on its name
function ToolIcon({
  toolName,
  className,
}: {
  toolName: string;
  className?: string;
}) {
  const name = toolName.toLowerCase();
  if (
    name.includes("bash") ||
    name.includes("shell") ||
    name.includes("terminal") ||
    name.includes("exec")
  ) {
    return <Terminal className={className} />;
  }
  if (
    name.includes("read") ||
    name.includes("file") ||
    name.includes("write")
  ) {
    return <FileText className={className} />;
  }
  if (
    name.includes("search") ||
    name.includes("grep") ||
    name.includes("find")
  ) {
    return <Search className={className} />;
  }
  if (
    name.includes("browser") ||
    name.includes("web") ||
    name.includes("http") ||
    name.includes("url")
  ) {
    return <Globe className={className} />;
  }
  if (
    name.includes("code") ||
    name.includes("edit") ||
    name.includes("patch")
  ) {
    return <Code className={className} />;
  }
  if (name.includes("list") || name.includes("dir") || name.includes("ls")) {
    return <FolderOpen className={className} />;
  }
  return <Wrench className={className} />;
}

// Format tool arguments for display
function formatToolArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/**
 * Render an `args` payload as a human-friendly preview, mimicking
 * how Claude Code's terminal renders tool calls. For Bash / Read /
 * Write / Edit / Grep / Glob / Agent / WebFetch / WebSearch we
 * extract the meaningful field(s) and format like a real CLI
 * invocation; for anything else we fall back to pretty-printed
 * JSON so we don't drop information. The result is plain text
 * with real newlines — NOT JSON-escaped — so a `<pre>` displays
 * it like a terminal.
 */
function formatToolArgsForDisplay(name: string, args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const obj = args as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof obj[k] === "string" ? (obj[k] as string) : null;
  const lower = name.toLowerCase();
  switch (lower) {
    case "bash": {
      const cmd = str("command");
      const desc = str("description");
      if (cmd) {
        return desc ? `# ${desc}\n$ ${cmd}` : `$ ${cmd}`;
      }
      break;
    }
    case "read": {
      const fp = str("file_path");
      const offset = obj["offset"];
      const limit = obj["limit"];
      if (fp) {
        const tail =
          offset || limit
            ? ` (lines ${offset ?? 1}${limit ? `..${Number(offset ?? 0) + Number(limit)}` : "+"})`
            : "";
        return `${fp}${tail}`;
      }
      break;
    }
    case "write": {
      const fp = str("file_path");
      const content = str("content");
      if (fp && content !== null) {
        return `${fp}\n\n${content}`;
      }
      break;
    }
    case "edit": {
      const fp = str("file_path");
      const oldS = str("old_string");
      const newS = str("new_string");
      if (fp) {
        const parts = [`${fp}`];
        if (oldS) parts.push(`- ${oldS.split("\n").join("\n- ")}`);
        if (newS) parts.push(`+ ${newS.split("\n").join("\n+ ")}`);
        return parts.join("\n");
      }
      break;
    }
    case "grep": {
      const pattern = str("pattern");
      const path = str("path");
      const glob = str("glob");
      if (pattern) {
        return `grep ${JSON.stringify(pattern)}${path ? ` in ${path}` : ""}${glob ? ` (${glob})` : ""}`;
      }
      break;
    }
    case "glob": {
      const pattern = str("pattern");
      const path = str("path");
      if (pattern) return `${pattern}${path ? ` in ${path}` : ""}`;
      break;
    }
    case "agent": {
      const desc = str("description");
      const subType = str("subagent_type");
      const prompt = str("prompt");
      const header = subType ? `[${subType}] ${desc ?? ""}` : (desc ?? "");
      return prompt ? `${header}\n\n${prompt}` : header;
    }
    case "webfetch": {
      const url = str("url");
      const prompt = str("prompt");
      if (url) return prompt ? `${url}\n# ${prompt}` : url;
      break;
    }
    case "websearch": {
      const query = str("query");
      if (query) return query;
      break;
    }
    case "todowrite":
      // Rendered by the dedicated TodoWriteItem; no preview text needed.
      return "";
  }
  return formatToolArgs(args);
}

/**
 * Render a tool result payload as plain terminal-style text. The
 * Bash backend wraps results as
 *   { content, stdout, stderr, is_error, interrupted }
 * — the user wants to see the stdout / content directly, not the
 * JSON envelope. Fall back to JSON for tools whose result shape we
 * don't recognise.
 */
function formatToolResultForDisplay(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const obj = result as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof obj[k] === "string" ? (obj[k] as string) : null;
  // Prefer `content` (Claude Code's normalized field), then stdout.
  // Append stderr below if present and non-empty.
  const content = str("content") ?? str("stdout") ?? str("output") ?? null;
  const stderr = str("stderr");
  const isError = obj["is_error"] === true || obj["success"] === false;
  if (content !== null || stderr) {
    const parts: string[] = [];
    if (content) parts.push(content);
    if (stderr && stderr.trim()) parts.push(`[stderr]\n${stderr}`);
    let out = parts.join("\n\n");
    if (isError && !out.toLowerCase().includes("error")) {
      out = `[error]\n${out}`;
    }
    return out;
  }
  return formatToolArgs(result);
}

/**
 * P4-#24: tool-output preview cap. Bash and similar tools can return
 * multi-MB result strings; rendering them inline freezes the page even
 * with the markdown cap. This helper splits the full string into a
 * 10KB preview + a `truncated` flag so the renderer can show a
 * "Show full output" affordance. We deliberately keep the preview
 * *prefix* (the first 10KB) since the head of a tool output is usually
 * what the user reads — the tail is logs or stack traces.
 */
const TOOL_RESULT_PREVIEW_BYTES = 10_000;

type ToolResultPreview = {
  preview: string;
  truncated: boolean;
  fullLength: number;
};

function formatToolResultPreview(result: unknown): ToolResultPreview {
  const full = formatToolArgs(result);
  return formatToolResultPreviewFromString(full);
}

/** Same head-truncation contract as `formatToolResultPreview` but
 *  starts from an already-stringified value (used after we render
 *  a tool result via the tool-aware formatter). */
function formatToolResultPreviewFromString(full: string): ToolResultPreview {
  if (full.length <= TOOL_RESULT_PREVIEW_BYTES) {
    return { preview: full, truncated: false, fullLength: full.length };
  }
  return {
    preview: full.slice(0, TOOL_RESULT_PREVIEW_BYTES),
    truncated: true,
    fullLength: full.length,
  };
}

// Truncate text for preview
function truncateText(text: string, maxLength: number = 100): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

// `TodoWrite` carries an `args.todos` array, where each item is
// `{ content, activeForm?, status: "pending" | "in_progress" | "completed" }`.
// Each TodoWrite call is a full snapshot of the agent's task list,
// not a diff — only the latest one for a given turn matters.
type TodoItem = {
  content: string;
  activeForm?: string | null;
  status: "pending" | "in_progress" | "completed";
};
function extractTodos(args: unknown): TodoItem[] | null {
  if (!args || typeof args !== "object") return null;
  const todos = (args as Record<string, unknown>)["todos"];
  if (!Array.isArray(todos)) return null;
  const out: TodoItem[] = [];
  for (const raw of todos) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const status = r["status"];
    if (
      typeof r["content"] !== "string" ||
      (status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed")
    ) {
      continue;
    }
    out.push({
      content: r["content"],
      activeForm:
        typeof r["activeForm"] === "string" ? r["activeForm"] : null,
      status,
    });
  }
  return out;
}

// Compact agent-task list view for Claude Code's `TodoWrite` tool.
// Renders the agent's plan as a checklist: ☐ pending, ◐ in-progress
// (uses `activeForm` when provided), ☒ completed (strikethrough).
const TodoWriteItem = memo(function TodoWriteItem({
  item,
  highlighted = false,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
  highlighted?: boolean;
}) {
  const todos = useMemo(() => extractTodos(item.args), [item.args]);
  if (!todos || todos.length === 0) {
    // Fallback to the generic chip if the args shape is unexpected.
    return <ToolCallItem item={item} highlighted={highlighted} />;
  }
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const t of todos) counts[t.status] += 1;
  return (
    <div
      id={`chat-item-${item.id}`}
      data-chat-item-id={item.id}
      className={cn(
        "my-2 rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden",
        highlighted && "ring-1 ring-amber-400/70 bg-amber-500/10",
      )}
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.04]">
        <div className="flex items-center gap-2 text-xs">
          <Flag className="h-3.5 w-3.5 text-indigo-400" />
          <span className="font-medium text-white/80">Agent tasks</span>
          <span className="text-white/30">{todos.length}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          {counts.in_progress > 0 && (
            <span className="flex items-center gap-1 text-amber-400">
              <Loader className="h-2.5 w-2.5 animate-spin" />
              {counts.in_progress}
            </span>
          )}
          {counts.completed > 0 && (
            <span className="text-emerald-400">{counts.completed} ✓</span>
          )}
          {counts.pending > 0 && (
            <span className="text-white/40">{counts.pending} todo</span>
          )}
        </div>
      </div>
      <ul className="px-3 py-2 space-y-1 text-xs">
        {todos.map((t, i) => {
          const label =
            t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
          return (
            <li key={i} className="flex items-start gap-2 leading-snug">
              {t.status === "completed" ? (
                <CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-400" />
              ) : t.status === "in_progress" ? (
                <Loader className="h-3 w-3 mt-0.5 shrink-0 text-amber-400 animate-spin" />
              ) : (
                <span className="h-3 w-3 mt-0.5 shrink-0 rounded-sm border border-white/30" />
              )}
              <span
                className={cn(
                  "text-white/80",
                  t.status === "completed" && "text-white/40 line-through",
                  t.status === "in_progress" && "text-amber-100",
                )}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

function isTodoWriteTool(toolName: string): boolean {
  return toolName.toLowerCase() === "todowrite";
}

// Plan-mode signals. Two distinct cases yield a finalized plan:
//   (a) `ExitPlanMode`: canonical — the agent calls this with the
//       plan content in `args.plan`. Fires when the agent
//       intentionally leaves plan mode to present a finalized
//       implementation strategy.
//   (b) `Write` to a `.claude/plans/*.md` path: Claude Code's
//       plan-mode writer dumps the draft plan to a file under
//       `.claude/plans/` even when ExitPlanMode is never called
//       (we've seen sessions with 6 EnterPlanMode but 0 ExitPlanMode
//       that still produced a plan via Write).
// The classifier returns the plan markdown if either matches.
function extractPlanFromTool(
  toolName: string,
  args: unknown,
): { plan: string; title: string; filePath: string | null } | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  const nameLower = toolName.toLowerCase();
  if (nameLower === "exitplanmode") {
    const plan = obj["plan"];
    if (typeof plan === "string" && plan.trim()) {
      return { plan, title: "Plan finalized", filePath: null };
    }
  }
  // Only Write counts as a "snapshot" of the plan — Edit's
  // `new_string` is just the inserted fragment, not the whole plan,
  // so we let Edit render as a regular tool card.
  if (nameLower === "write") {
    const fp = obj["file_path"];
    if (typeof fp === "string" && /\.claude\/plans\/[^/]+\.md$/i.test(fp)) {
      const content = obj["content"];
      if (typeof content === "string" && content.trim()) {
        const base = fp.split("/").pop()?.replace(/\.md$/i, "") ?? "Plan";
        return {
          plan: content,
          title: `Plan: ${base.replace(/[-_]/g, " ")}`,
          filePath: fp,
        };
      }
    }
  }
  return null;
}

function isPlanTool(toolName: string, args: unknown): boolean {
  return extractPlanFromTool(toolName, args) !== null;
}

/**
 * Plan-card "key": the file path for plan-file Writes (so multiple
 * Writes to the same file dedupe), or the tool_call_id for
 * ExitPlanMode (which is canonical and per-call, never deduped).
 * `null` when the tool isn't a plan tool at all.
 */
function planToolDedupeKey(
  toolName: string,
  args: unknown,
  toolCallId: string,
): string | null {
  const info = extractPlanFromTool(toolName, args);
  if (!info) return null;
  return info.filePath ?? toolCallId;
}

// Right-side workbench panel showing the agent's CURRENT task list.
// Driven by `latestAgentTodos` (a memo that picks the most recent
// TodoWrite snapshot from the mission's chat items). Each TodoWrite
// is a full plan, not a diff — only the newest matters. Hidden when
// no todos are present.
// Compact in-chat card for a finalized plan. Click → full-screen
// markdown modal so the user can actually read the plan. Same
// dispatcher slot as TodoWriteItem / SubagentToolItem.
const PlanItem = memo(function PlanItem({
  item,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
}) {
  const planInfo = useMemo(
    () => extractPlanFromTool(item.name, item.args),
    [item.name, item.args],
  );
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!planInfo) return null;
  const lineCount = planInfo.plan.split("\n").length;
  return (
    <>
      <div
        id={`chat-item-${item.id}`}
        data-chat-item-id={item.id}
        className="my-2 rounded-lg border border-violet-500/30 bg-violet-500/[0.06] overflow-hidden"
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-violet-500/[0.1] transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="h-4 w-4 text-violet-300 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-violet-100 truncate">
                {planInfo.title}
              </p>
              <p className="text-[11px] text-white/40">
                {lineCount} line{lineCount === 1 ? "" : "s"} · click to view
              </p>
            </div>
          </div>
          <span className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-violet-500/20 text-violet-200 hover:bg-violet-500/30">
            <Eye className="h-3.5 w-3.5" />
            Show plan
          </span>
        </button>
      </div>

      {open && mounted &&
        createPortal(
          <div
            className="fixed inset-0 z-[80] flex items-stretch justify-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plan-modal-title"
          >
            <div
              className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
              onClick={() => setOpen(false)}
            />
            <div className="relative w-full h-full flex flex-col bg-[#101010] sm:m-3 sm:rounded-2xl sm:border sm:border-white/[0.06] shadow-2xl animate-in fade-in zoom-in-95 duration-150 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="h-4 w-4 text-violet-400 shrink-0" />
                  <h3
                    id="plan-modal-title"
                    className="text-sm font-medium text-white truncate"
                  >
                    {planInfo.title}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="p-1.5 rounded-md text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors"
                  title="Close (Esc)"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="mx-auto max-w-4xl xl:max-w-5xl px-6 py-6 prose-glass">
                  <MarkdownContent content={planInfo.plan} />
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
});

/**
 * Esc-Esc opens this modal. Lists past user/assistant turns
 * (newest first); each row offers three actions like Claude
 * Code's `/restore`:
 *   • Restore conversation       — truncate events after this
 *     point (active today)
 *   • Restore conversation + code — also `git checkout` files
 *     to the snapshot for this turn (disabled until per-turn
 *     snapshots ship — backend returns 501)
 *   • Summarise to here          — replace earlier turns with
 *     an LLM-driven summary (disabled until backend lands)
 *
 * On Restore success the parent re-fetches events; the local
 * state is otherwise stale because we just deleted DB rows.
 */
function RestoreCheckpointModal({
  open,
  items,
  missionId,
  onClose,
  onRestored,
}: {
  open: boolean;
  items: ChatItem[];
  missionId: string | null;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    if (!open) {
      setError(null);
      setPending(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Collect user_message events with their immediate assistant
  // reply preview. Newest first so the user sees what they just
  // typed at the top.
  const checkpoints = useMemo(() => {
    type Cp = {
      eventId: string;
      timestamp: number;
      userText: string;
      replyPreview: string | null;
    };
    const out: Cp[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "user") continue;
      // Find the next assistant message (or another user — that
      // means the agent never replied, still a valid checkpoint).
      let preview: string | null = null;
      for (let j = i + 1; j < items.length; j++) {
        if (items[j].kind === "assistant") {
          preview = (items[j] as Extract<ChatItem, { kind: "assistant" }>).content;
          break;
        }
        if (items[j].kind === "user") break;
      }
      out.push({
        eventId: it.id,
        timestamp: it.timestamp,
        userText: it.content,
        replyPreview: preview ? preview.slice(0, 140) : null,
      });
    }
    return out.reverse();
  }, [items]);

  const restore = useCallback(
    async (eventId: string, mode: string) => {
      if (!missionId) return;
      setPending(eventId + mode);
      setError(null);
      try {
        const API_BASE = getRuntimeApiBase();
        const res = await fetch(
          `${API_BASE}/api/control/missions/${missionId}/restore`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...authHeader(),
            },
            body: JSON.stringify({ event_id: eventId, mode }),
          },
        );
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`HTTP ${res.status}: ${txt}`);
        }
        onRestored();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
      }
    },
    [missionId, onRestored],
  );

  if (!mounted || !open || !missionId) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[85] flex items-stretch justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Restore conversation checkpoint"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
        onClick={onClose}
      />
      <div className="relative w-full max-w-3xl flex flex-col bg-[#101010] rounded-2xl border border-white/[0.06] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 my-auto max-h-[85vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-indigo-400" />
            <span className="text-sm font-medium text-white/90">
              Restore checkpoint
            </span>
            <span className="text-xs text-white/40 font-mono">
              ({checkpoints.length})
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/70 transition-colors"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {error && (
          <div className="px-4 py-2 text-xs text-red-300 bg-red-500/10 border-b border-red-500/20">
            {error}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {checkpoints.length === 0 ? (
            <p className="p-6 text-sm text-white/40 text-center">
              No checkpoints yet — send a message first.
            </p>
          ) : (
            <ul className="divide-y divide-white/[0.04]">
              {checkpoints.map((cp) => {
                const isLatest = cp.eventId === checkpoints[0].eventId;
                return (
                  <li key={cp.eventId} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-white/40 font-mono">
                        {new Date(cp.timestamp).toLocaleString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                          month: "short",
                          day: "numeric",
                        })}
                        {isLatest && (
                          <span className="ml-1 text-emerald-400/80">
                            · current
                          </span>
                        )}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-white/85 line-clamp-3 whitespace-pre-wrap break-words">
                      {cp.userText}
                    </p>
                    {cp.replyPreview && (
                      <p className="mt-1 text-xs text-white/45 line-clamp-2 italic">
                        ↳ {cp.replyPreview}
                        {cp.replyPreview.length >= 140 && "…"}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={
                          pending === cp.eventId + "conversation" || isLatest
                        }
                        onClick={() => void restore(cp.eventId, "conversation")}
                        className={cn(
                          "flex items-center gap-1 px-2.5 py-1 text-[11px] rounded border transition-colors",
                          isLatest
                            ? "border-white/[0.04] bg-white/[0.02] text-white/30 cursor-not-allowed"
                            : "border-indigo-500/30 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/15 disabled:opacity-50",
                        )}
                        title={
                          isLatest
                            ? "Already at this checkpoint"
                            : "Drop all events after this point. Files untouched."
                        }
                      >
                        {pending === cp.eventId + "conversation" ? (
                          <Loader className="h-3 w-3 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3 w-3" />
                        )}
                        Restore conversation
                      </button>
                      <button
                        type="button"
                        disabled
                        className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded border border-white/[0.04] bg-white/[0.02] text-white/30 cursor-not-allowed"
                        title="Needs per-turn git snapshots — backend returns 501 until that ships."
                      >
                        <RotateCcw className="h-3 w-3" />
                        Restore + code
                      </button>
                      <button
                        type="button"
                        disabled
                        className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded border border-white/[0.04] bg-white/[0.02] text-white/30 cursor-not-allowed"
                        title="LLM-driven compaction not wired yet."
                      >
                        Summarise to here
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="px-4 py-2 border-t border-white/[0.06] text-[10px] text-white/40">
          Tip: <kbd className="px-1 py-0.5 rounded bg-white/[0.06]">Esc</kbd>{" "}
          <kbd className="px-1 py-0.5 rounded bg-white/[0.06]">Esc</kbd> to
          open this menu.
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Horizontal tab strip pinned above the page header. One tab
 * per non-terminal mission (filter out completed / failed /
 * cancelled via `isFinishedStatus`). Active mission gets the
 * indigo highlight. The X on each tab is a Cancel (not Delete);
 * deleting from this strip would be too easy to fat-finger
 * and the mission switcher already exposes the destructive op.
 *
 * Cmd-Shift-[ / Cmd-Shift-] cycle through this strip — handled
 * by a global keydown listener in ControlClient.
 */
function MissionTabBar({
  missions,
  viewingMissionId,
  runningMissions,
  onSelect,
  onCancel,
}: {
  missions: Mission[];
  viewingMissionId: string | null;
  runningMissions: RunningMissionInfo[];
  onSelect: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const tabs = useMemo(
    () => missions.filter((m) => !isFinishedStatus(m.status)),
    [missions],
  );
  const runningSet = useMemo(
    () => new Set(runningMissions.map((r) => r.mission_id)),
    [runningMissions],
  );
  if (tabs.length <= 1) return null;
  return (
    <div className="relative z-10 mb-2 -mx-2 sm:-mx-4 lg:-mx-6 border-b border-white/[0.06] bg-black/20 backdrop-blur-sm">
      <div className="overflow-x-auto px-2 sm:px-4 lg:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex items-center gap-0.5 py-1 whitespace-nowrap">
        {tabs.map((m) => {
          const isActive = m.id === viewingMissionId;
          const isRunning = runningSet.has(m.id);
          const title = m.title?.trim() || getMissionShortName(m.id);
          return (
            <div
              key={m.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => onSelect(m.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(m.id);
                }
              }}
              className={cn(
                "shrink-0 group flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-md text-[12px] cursor-pointer transition-colors",
                isActive
                  ? "bg-indigo-500/20 text-indigo-100 border border-indigo-500/30"
                  : "border border-transparent text-white/70 hover:bg-white/[0.04] hover:text-white",
              )}
              title={`${title} · ${m.status}`}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full shrink-0",
                  missionStatusDotClass(m.status, isRunning),
                )}
              />
              <span className="max-w-[180px] truncate">{title}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel(m.id);
                }}
                className="opacity-0 group-hover:opacity-70 hover:!opacity-100 p-0.5 rounded text-white/50 hover:text-rose-300 hover:bg-rose-500/15 transition-opacity"
                title="Cancel mission"
                tabIndex={-1}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}

function ChangesModal({
  open,
  missionId,
  onClose,
  pendingOpen,
  onPendingOpenConsumed,
}: {
  open: boolean;
  missionId: string | null;
  onClose: () => void;
  pendingOpen?: { repo: string; path: string; line?: number } | null;
  onPendingOpenConsumed?: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  // Don't tear down ChangesPanel when the user closes the modal —
  // its internal state (open tabs, edit buffers, scroll, dirty
  // flags, fetched changes data) is expensive to rebuild. Once
  // we've ever opened the modal for a mission, keep the panel
  // mounted; just hide its host div via CSS when closed. Monaco's
  // `automaticLayout: true` re-measures on the next show, so the
  // editor renders cleanly when the modal reopens.
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    setMounted(true);
    console.log("[ChangesModal] mount");
    return () => console.log("[ChangesModal] unmount");
  }, []);
  useEffect(() => {
    console.log("[ChangesModal] missionId change", { missionId });
  }, [missionId]);
  useEffect(() => {
    console.log("[ChangesModal] open change", { open });
  }, [open]);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted || !missionId) return null;
  if (!everOpened) return null;
  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[80] flex items-stretch justify-center",
        // When closed: invisible + non-interactive, but the
        // children stay mounted so ChangesPanel preserves its
        // tabs / edit buffers / cached changes data.
        !open && "pointer-events-none invisible",
      )}
      role="dialog"
      aria-modal="true"
      aria-label="Mission changes"
      aria-hidden={!open}
    >
      <div
        className={cn(
          "absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-150",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={open ? onClose : undefined}
      />
      <div
        className={cn(
          "relative w-full h-full flex flex-col bg-[#101010] sm:m-3 sm:rounded-2xl sm:border sm:border-white/[0.06] shadow-2xl overflow-hidden transition-opacity duration-150",
          open ? "opacity-100" : "opacity-0",
        )}
      >
        {/* `key={missionId}` forces a clean unmount/remount when the
            user switches missions. The preserve-state pattern (modal
            stays mounted across open/close) is fine for one mission
            because the children just rerender with the same props, but
            switching missions re-binds Monaco's editors / LSP attach
            to a different /workspaces/repos tree; without a key the
            old Monaco DOM nodes get re-used with stale parent refs and
            React throws "Cannot read properties of null (reading
            'removeChild')" during the commit phase. */}
        <ChangesPanel
          key={missionId ?? "none"}
          missionId={missionId}
          onClose={onClose}
          pendingOpen={pendingOpen}
          onPendingOpenConsumed={onPendingOpenConsumed}
        />
      </div>
    </div>,
    document.body,
  );
}

function AgentTasksPanel({
  todos,
  onClose,
  className,
}: {
  todos: TodoItem[];
  onClose: () => void;
  className?: string;
}) {
  if (todos.length === 0) return null;
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const t of todos) counts[t.status] += 1;
  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl glass-panel border border-white/[0.06] overflow-hidden",
        className,
      )}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <Flag className="h-4 w-4 text-indigo-400" />
          <span className="text-sm font-medium text-white/90">Agent tasks</span>
          <span className="text-xs text-white/40 font-mono">
            {todos.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-[10px]">
            {counts.in_progress > 0 && (
              <span className="flex items-center gap-1 text-amber-400">
                <Loader className="h-2.5 w-2.5 animate-spin" />
                {counts.in_progress}
              </span>
            )}
            {counts.completed > 0 && (
              <span className="text-emerald-400">{counts.completed} ✓</span>
            )}
            {counts.pending > 0 && (
              <span className="text-white/40">{counts.pending} todo</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/70 transition-colors"
            title="Close agent tasks"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <ul className="flex-1 overflow-y-auto px-3 py-2 space-y-1 text-sm">
        {todos.map((t, i) => {
          const label =
            t.status === "in_progress" && t.activeForm
              ? t.activeForm
              : t.content;
          return (
            <li key={i} className="flex items-start gap-2 leading-snug py-0.5">
              {t.status === "completed" ? (
                <CheckCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-400" />
              ) : t.status === "in_progress" ? (
                <Loader className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400 animate-spin" />
              ) : (
                <span className="h-3.5 w-3.5 mt-0.5 shrink-0 rounded-sm border border-white/30" />
              )}
              <span
                className={cn(
                  "text-white/80",
                  t.status === "completed" && "text-white/40 line-through",
                  t.status === "in_progress" && "text-amber-100",
                )}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Check if a tool is a subagent/background task tool.
// `"agent"` is Claude Code's parallel-task tool (the one whose call
// args carry `subagent_type` / `description` / `prompt`); without it
// classified as a sub-agent here, Agent calls render as generic tool
// cards and never appear in the SubagentsPanel.
function isSubagentTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name === "agent" ||
    name === "background_task" ||
    name === "task" ||
    name.includes("subagent") ||
    name.includes("spawn_agent") ||
    name.includes("delegate")
  );
}

// Extract subagent info from tool args
function extractSubagentInfo(args: unknown): {
  agentName: string | null;
  description: string | null;
  prompt: string | null;
} {
  if (!args || typeof args !== "object") {
    return { agentName: null, description: null, prompt: null };
  }
  const argsObj = args as Record<string, unknown>;
  return {
    agentName:
      typeof argsObj.agent === "string"
        ? argsObj.agent
        : typeof argsObj.subagent_type === "string"
          ? argsObj.subagent_type
          : typeof argsObj.name === "string"
            ? argsObj.name
            : null,
    description:
      typeof argsObj.description === "string" ? argsObj.description : null,
    prompt: typeof argsObj.prompt === "string" ? argsObj.prompt : null,
  };
}

// Parse subagent result for summary stats
function parseSubagentResult(result: unknown): {
  success: boolean;
  cancelled: boolean;
  summary: string | null;
} {
  if (!result) return { success: false, cancelled: false, summary: null };

  // Handle string results
  if (typeof result === "string") {
    // Strip out <task_metadata>...</task_metadata> blocks entirely
    const cleanedResult = result
      .replace(/<task_metadata>[\s\S]*?<\/task_metadata>/gi, "")
      .trim();
    // Check for explicit error indicators at the start, not just keyword presence
    const trimmedLower = cleanedResult.toLowerCase();
    const isError =
      trimmedLower.startsWith("error:") ||
      trimmedLower.startsWith("error -") ||
      trimmedLower.startsWith("failed:") ||
      trimmedLower.startsWith("exception:");
    // Try to extract a meaningful summary from the result
    const lines = cleanedResult.split("\n").filter((l) => l.trim());
    const summary = lines.length > 0 ? truncateText(lines[0], 100) : null;
    return { success: !isError, cancelled: false, summary };
  }

  // Handle object results
  if (typeof result === "object") {
    const resultObj = result as Record<string, unknown>;
    const statusLower =
      typeof resultObj.status === "string"
        ? resultObj.status.toLowerCase()
        : "";
    const isCancelled = statusLower === "cancelled";
    const isError =
      !isCancelled &&
      (resultObj.error !== undefined ||
        resultObj.is_error === true ||
        resultObj.success === false ||
        statusLower === "error" ||
        statusLower === "failed");
    const summary =
      typeof resultObj.summary === "string"
        ? resultObj.summary
        : typeof resultObj.message === "string"
          ? resultObj.message
          : typeof resultObj.reason === "string"
            ? resultObj.reason
            : typeof resultObj.result === "string"
              ? truncateText(resultObj.result, 100)
              : null;
    return {
      success: !isError && !isCancelled,
      cancelled: isCancelled,
      summary,
    };
  }

  return { success: true, cancelled: false, summary: null };
}

// Subagent/Background Task tool item with enhanced UX
// Memoized to prevent re-renders when parent state changes
const SubagentToolItem = memo(function SubagentToolItem({
  item,
  highlighted = false,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
  highlighted?: boolean;
}) {
  // Default-open sub-agent card: spawn description + prompt visible
  // immediately, click the chevron to collapse.
  const [expanded, setExpanded] = useState(true);
  const isDone = item.result !== undefined;

  // Memoize subagent info extraction
  const { agentName, description, prompt } = useMemo(
    () => extractSubagentInfo(item.args),
    [item.args],
  );

  // Memoize result parsing
  const { success, cancelled, summary } = useMemo(
    () =>
      isDone
        ? parseSubagentResult(item.result)
        : { success: false, cancelled: false, summary: null },
    [isDone, item.result],
  );

  // Done rows render a fixed duration string; only active rows tick via
  // `<LiveDuration>`. This keeps the per-second tick from re-rendering
  // every visible done tool card (see LiveDuration definition).
  const doneDuration =
    isDone && item.endTime
      ? formatDuration(Math.floor((item.endTime - item.startTime) / 1000))
      : null;

  // Memoize result string formatting — use the tool-aware
  // formatter so Bash / Read / Grep stdout shows as raw terminal
  // text instead of `{"content":"...","stdout":"..."}` JSON.
  const resultStr = useMemo(
    () =>
      item.result !== undefined ? formatToolResultForDisplay(item.result) : null,
    [item.result],
  );

  return (
    <div
      id={`chat-item-${item.id}`}
      data-chat-item-id={item.id}
      className={cn(
        "my-3 rounded-xl transition-colors",
        highlighted && "ring-1 ring-amber-400/70 bg-amber-500/10",
      )}
    >
      {/* Main card */}
      <div
        className={cn(
          "rounded-lg border overflow-hidden",
          "bg-white/[0.02]",
          !isDone && "border-purple-500/30",
          isDone && cancelled && "border-amber-500/20",
          isDone && success && !cancelled && "border-emerald-500/20",
          isDone && !success && !cancelled && "border-red-500/20",
        )}
      >
        {/* Header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "w-full flex items-center gap-3 px-3 py-2",
            "hover:bg-white/[0.02] transition-colors",
          )}
        >
          {/* Icon */}
          <div
            className={cn(
              "flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center",
              !isDone && "bg-purple-500/20",
              isDone && cancelled && "bg-amber-500/20",
              isDone && success && !cancelled && "bg-emerald-500/20",
              isDone && !success && !cancelled && "bg-red-500/20",
            )}
          >
            {!isDone ? (
              <Cpu className="h-4 w-4 text-purple-400 animate-pulse" />
            ) : cancelled ? (
              <XCircle className="h-4 w-4 text-amber-400" />
            ) : success ? (
              <CheckCircle className="h-4 w-4 text-emerald-400" />
            ) : (
              <XCircle className="h-4 w-4 text-red-400" />
            )}
          </div>

          {/* Info */}
          <div className="flex-1 text-left min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "text-sm font-medium",
                  !isDone && "text-purple-300",
                  isDone && cancelled && "text-amber-300",
                  isDone && success && !cancelled && "text-emerald-300",
                  isDone && !success && !cancelled && "text-red-300",
                )}
              >
                {agentName || "Subagent"}
              </span>
              {description && (
                <span className="text-xs text-white/40 truncate">
                  {truncateText(description, 40)}
                </span>
              )}
            </div>

            {/* Status line */}
            <div className="flex items-center gap-2 mt-0.5">
              {!isDone ? (
                <>
                  <span className="text-xs text-white/50">
                    Running for <LiveDuration startTime={item.startTime} />
                  </span>
                  <Loader className="h-3 w-3 animate-spin text-purple-400" />
                </>
              ) : cancelled ? (
                <>
                  <span className="text-xs text-amber-400">Cancelled</span>
                  {summary && (
                    <span className="text-xs text-white/40 truncate max-w-[200px]">
                      · {summary}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="text-xs text-white/50">
                    Completed in {doneDuration ?? "<1s"}
                  </span>
                  {summary && (
                    <span className="text-xs text-white/40 truncate max-w-[200px]">
                      · {summary}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Peek toggle */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <span
              className={cn(
                "text-[10px] uppercase tracking-wider transition-colors",
                expanded ? "text-white/50" : "text-white/30",
              )}
            >
              {expanded ? "Hide" : "Peek"}
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-white/30 transition-transform duration-200",
                expanded ? "rotate-0" : "-rotate-90",
              )}
            />
          </div>
        </button>

        {/* Progress bar (only when running) */}
        {!isDone && (
          <div className="h-1 bg-purple-500/10">
            <div
              className="h-full bg-purple-500/50 animate-pulse"
              style={{
                width: "100%",
                background:
                  "linear-gradient(90deg, transparent, rgba(168, 85, 247, 0.5), transparent)",
                animation: "shimmer 2s infinite",
              }}
            />
          </div>
        )}

        {/* Expandable content — conditionally rendered (issue #156) */}
        {expanded && (
          <div>
            <div className="px-3 py-3 space-y-3 border-t border-white/[0.06]">
              {/* Prompt preview */}
              {prompt && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-white/30 mb-1">
                    Task
                  </div>
                  <div className="text-xs text-white/60 bg-black/20 rounded p-2 max-h-24 overflow-y-auto">
                    {truncateText(prompt, 300)}
                  </div>
                </div>
              )}

              {/* Result */}
              {resultStr !== null && (
                <div>
                  <div
                    className={cn(
                      "text-[10px] uppercase tracking-wider mb-1",
                      !success ? "text-red-400/70" : "text-emerald-400/70",
                    )}
                  >
                    {!success ? "Error" : "Result"}
                  </div>
                  <div
                    className={cn(
                      "max-h-60 overflow-y-auto rounded",
                      !success && "[&_pre]:!bg-red-500/10",
                    )}
                  >
                    <LazyJsonHighlighter
                      background={
                        !success ? "rgba(239, 68, 68, 0.1)" : undefined
                      }
                      textColor={!success ? "rgb(248, 113, 113)" : undefined}
                    >
                      {resultStr}
                    </LazyJsonHighlighter>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

// Extract image file paths from tool result strings
// Matches patterns like "/path/to/image.png" or "screenshots/file.jpg"
function extractImagePaths(text: string): string[] {
  const paths: string[] = [];
  // Use shared pattern from file-extensions.ts
  // Reset regex state since it's global
  IMAGE_PATH_PATTERN.lastIndex = 0;
  const matches = text.match(IMAGE_PATH_PATTERN);
  if (matches) {
    for (const match of matches) {
      // Normalize and dedupe
      const normalized = match.trim();
      if (!paths.includes(normalized)) {
        paths.push(normalized);
      }
    }
  }
  return paths;
}

// Component to display an image preview with click-to-open functionality
function ImagePreview({
  path,
  workspaceId,
  missionId,
}: {
  path: string;
  workspaceId?: string;
  missionId?: string;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const loadImage = async () => {
      setLoading(true);
      setError(null);
      try {
        const API_BASE = getRuntimeApiBase();
        const params = new URLSearchParams({ path });
        if (workspaceId) params.set("workspace_id", workspaceId);
        if (missionId) params.set("mission_id", missionId);
        const res = await fetch(
          `${API_BASE}/api/fs/download?${params.toString()}`,
          {
            headers: { ...authHeader() },
          },
        );
        if (!res.ok) {
          throw new Error(`Failed to load image: ${res.status}`);
        }
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        objectUrl = url;
        setImageUrl(url);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load image");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadImage();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, workspaceId, missionId]);

  const openInNewTab = () => {
    if (imageUrl) {
      window.open(imageUrl, "_blank");
    }
  };

  const fileName = path.split("/").pop() || path;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-white/40 py-2">
        <Loader className="h-3 w-3 animate-spin" />
        <span>Loading {fileName}...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-xs text-red-400/70 py-2">
        <AlertTriangle className="h-3 w-3" />
        <span>{error}</span>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wider text-white/30 mb-1 flex items-center gap-2">
        <ImageIcon aria-hidden="true" className="h-3 w-3" />
        Screenshot Preview
      </div>
      <div
        className="relative group cursor-pointer rounded-lg overflow-hidden border border-white/10 hover:border-white/20 transition-colors"
        onClick={openInNewTab}
        title="Click to open in new tab"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl || ""}
          alt={fileName}
          className="max-w-full max-h-60 object-contain bg-black/20"
        />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
          <div className="flex items-center gap-2 text-white text-sm bg-black/60 px-3 py-1.5 rounded-full">
            <ExternalLink className="h-4 w-4" />
            Open in new tab
          </div>
        </div>
      </div>
      <div className="text-[10px] text-white/30 mt-1 truncate">{path}</div>
    </div>
  );
}

// Tool call item component with collapsible UI
// Memoized to prevent re-renders when parent state changes
const ToolCallItem = memo(function ToolCallItem({
  item,
  highlighted = false,
  workspaceId,
  missionId,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
  highlighted?: boolean;
  workspaceId?: string;
  missionId?: string;
}) {
  // Default-open: args + result preview visible immediately so the
  // user can scan a turn without click-to-expand on every chip.
  const [expanded, setExpanded] = useState(true);
  const isDone = item.result !== undefined;

  // Only running tools live-tick (via `<LiveDuration>` below). Done rows
  // freeze on a fixed string; previously every visible done tool subscribed
  // to the 1 Hz tick for a value it never displayed.
  const doneDuration =
    isDone && item.endTime
      ? formatDuration(Math.floor((item.endTime - item.startTime) / 1000))
      : null;

  // Memoize expensive string formatting - only recompute when item.args changes
  // Use the tool-aware formatter so Bash shows `$ <cmd>` not the raw
  // `{"command": "...", "description": "..."}` JSON envelope.
  const argsStr = useMemo(
    () => formatToolArgsForDisplay(item.name, item.args),
    [item.name, item.args],
  );

  // P4-#24 preview cap: split into 10KB head + truncated flag so we
  // don't feed multi-MB bash outputs into the syntax highlighter.
  // Use the tool-aware result formatter so Bash / Read / Grep show
  // their stdout / file content as plain text (with real newlines)
  // instead of the JSON `{"content":"...","stdout":"..."}` envelope.
  const resultPreview = useMemo(() => {
    if (item.result === undefined) return null;
    const rendered = formatToolResultForDisplay(item.result);
    return formatToolResultPreviewFromString(rendered);
  }, [item.result]);
  const resultStr = resultPreview?.preview ?? null;
  // Default-show the full result; user can collapse to the preview via
  // the existing toggle button (semantics flipped from previous default).
  const [resultExpanded, setResultExpanded] = useState(true);

  // Memoize cancelled detection - check if tool was cancelled due to mission ending
  const isCancelled = useMemo(() => {
    if (typeof item.result === "object" && item.result !== null) {
      const resultObj = item.result as Record<string, unknown>;
      return resultObj.status === "cancelled";
    }
    return false;
  }, [item.result]);

  // Memoize error detection - only recompute when result changes
  const isError = useMemo(() => {
    if (resultStr === null || isCancelled) return false;

    // Check if the result is an object with explicit error fields
    if (typeof item.result === "object" && item.result !== null) {
      const resultObj = item.result as Record<string, unknown>;
      if (
        resultObj.error !== undefined ||
        resultObj.is_error === true ||
        resultObj.success === false
      ) {
        return true;
      }
    }

    // Check if the string result starts with error indicators (more specific than keyword search)
    const trimmedLower = resultStr.trim().toLowerCase();
    return (
      trimmedLower.startsWith("error:") ||
      trimmedLower.startsWith("error -") ||
      trimmedLower.startsWith("failed:") ||
      trimmedLower.startsWith("exception:")
    );
  }, [item.result, resultStr, isCancelled]);

  // Memoize args preview - only recompute when item.args changes
  const argsPreview = useMemo(
    () =>
      truncateText(
        typeof item.args === "object" && item.args !== null
          ? Object.keys(item.args as Record<string, unknown>)
              .slice(0, 2)
              .join(", ")
          : argsStr,
        50,
      ),
    [item.args, argsStr],
  );

  return (
    <div
      id={`chat-item-${item.id}`}
      data-chat-item-id={item.id}
      className={cn(
        "my-2 rounded-xl transition-colors",
        highlighted && "ring-1 ring-amber-400/70 bg-amber-500/10",
      )}
    >
      {/* Compact header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-full",
          "bg-white/[0.04] border border-white/[0.06]",
          "text-white/40 hover:text-white/60 hover:bg-white/[0.06]",
          "transition-all duration-200",
          !isDone && "border-amber-500/20",
          isDone && isCancelled && "border-amber-500/20",
          isDone && !isError && !isCancelled && "border-emerald-500/20",
          isDone && isError && "border-red-500/20",
        )}
      >
        <ToolIcon
          toolName={item.name}
          className={cn(
            "h-3 w-3",
            !isDone && "animate-pulse text-amber-400",
            isDone && isCancelled && "text-amber-400",
            isDone && !isError && !isCancelled && "text-emerald-400",
            isDone && isError && "text-red-400",
          )}
        />
        <span className="text-xs font-mono text-indigo-400">{item.name}</span>
        {argsPreview && (
          <span className="text-xs text-white/30 truncate max-w-[150px]">
            ({argsPreview})
          </span>
        )}
        <span className="text-xs text-white/30 ml-1">
          {isDone ? (
            isCancelled ? (
              "cancelled"
            ) : (
              (doneDuration ?? "<1s")
            )
          ) : (
            <>
              <LiveDuration startTime={item.startTime} />
              ...
            </>
          )}
        </span>
        {isDone && !isError && !isCancelled && (
          <CheckCircle className="h-3 w-3 text-emerald-400" />
        )}
        {isDone && isCancelled && (
          <XCircle className="h-3 w-3 text-amber-400" />
        )}
        {isDone && isError && <XCircle className="h-3 w-3 text-red-400" />}
        {!isDone && <Loader className="h-3 w-3 animate-spin text-amber-400" />}
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform duration-200 ml-1",
            expanded ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>

      {/* Expandable content — conditionally rendered to avoid mounting
          SyntaxHighlighter while collapsed (issue #156). */}
      {expanded && (
        <div className="mt-2">
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-3">
            {/* Arguments */}
            {argsStr && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-white/30 mb-1">
                  Arguments
                </div>
                <div className="max-h-40 overflow-y-auto rounded">
                  <LazyJsonHighlighter>{argsStr}</LazyJsonHighlighter>
                </div>
              </div>
            )}

            {/* Result */}
            {resultStr !== null && (
              <div>
                <div
                  className={cn(
                    "text-[10px] uppercase tracking-wider mb-1",
                    isError ? "text-red-400/70" : "text-emerald-400/70",
                  )}
                >
                  {isError ? "Error" : "Result"}
                </div>
                <div
                  className={cn(
                    "max-h-40 overflow-y-auto rounded",
                    isError && "[&_pre]:!bg-red-500/10",
                  )}
                >
                  <LazyJsonHighlighter
                    background={isError ? "rgba(239, 68, 68, 0.1)" : undefined}
                    textColor={isError ? "rgb(248, 113, 113)" : undefined}
                  >
                    {resultExpanded && item.result !== undefined
                      ? formatToolResultForDisplay(item.result)
                      : (resultStr ?? "")}
                  </LazyJsonHighlighter>
                </div>
                {resultPreview?.truncated && (
                  <div className="mt-1 flex items-center justify-between text-[10px] text-white/40">
                    <span>
                      {resultExpanded
                        ? `Showing full output (${(resultPreview.fullLength / 1024).toFixed(0)} KB)`
                        : `Showing first ${(TOOL_RESULT_PREVIEW_BYTES / 1024).toFixed(0)} KB of ${(resultPreview.fullLength / 1024).toFixed(0)} KB`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setResultExpanded((v) => !v)}
                      className="rounded bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-white/70 hover:bg-white/[0.08]"
                    >
                      {resultExpanded ? "Show preview" : "Show full output"}
                    </button>
                  </div>
                )}
                {/* Image previews for screenshot results - only from tools that produce images */}
                {(() => {
                  // Only extract images from tools that actually produce screenshots
                  const IMAGE_PRODUCING_TOOLS = [
                    "capture",
                    "screenshot",
                    "desktop_screenshot",
                    "mccli",
                    "browser_take_screenshot",
                  ];
                  const toolName = item.name.toLowerCase();
                  if (!IMAGE_PRODUCING_TOOLS.some((t) => toolName.includes(t)))
                    return null;

                  const imagePaths = extractImagePaths(resultStr);
                  if (imagePaths.length === 0) return null;
                  return (
                    <div className="space-y-2">
                      {imagePaths.map((path) => (
                        <ImagePreview
                          key={path}
                          path={path}
                          workspaceId={workspaceId}
                          missionId={missionId}
                        />
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Still running indicator */}
            {!isDone && (
              <div className="flex items-center gap-2 text-xs text-amber-400/70">
                <Loader className="h-3 w-3 animate-spin" />
                <span>
                  Running for <LiveDuration startTime={item.startTime} />
                  ...
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// Collapsed tool group component - shows last tool with expand option
function CollapsedToolGroup({
  tools,
  isExpanded,
  onToggleExpand,
  workspaceId,
  missionId,
  visiblePlanToolIds,
}: {
  tools: Extract<ChatItem, { kind: "tool" }>[];
  isExpanded: boolean;
  onToggleExpand: () => void;
  workspaceId?: string;
  missionId?: string;
  visiblePlanToolIds?: Set<string>;
}) {
  const hiddenCount = tools.length - 1;
  const lastTool = tools[tools.length - 1];

  // Helper to render appropriate tool component
  const renderTool = (tool: Extract<ChatItem, { kind: "tool" }>) => {
    if (isSubagentTool(tool.name)) {
      return <SubagentToolItem key={tool.id} item={tool} />;
    }
    // TodoWrite calls render in the right-side workbench panel
    // (AgentTasksPanel) as a single always-latest checklist, NOT
    // as one card per turn. Filtering here keeps the chat clean.
    if (isTodoWriteTool(tool.name)) {
      return null;
    }
    // ExitPlanMode + Write to `.claude/plans/*.md` → "Plan" card
    // with a full-screen markdown modal. Earlier Writes to the
    // same plan file are deduped away by `visiblePlanToolIds`
    // (only the latest snapshot per file path renders).
    if (isPlanTool(tool.name, tool.args)) {
      if (visiblePlanToolIds && !visiblePlanToolIds.has(tool.id)) {
        return null;
      }
      return <PlanItem key={tool.id} item={tool} />;
    }
    return (
      <ToolCallItem
        key={tool.id}
        item={tool}
        workspaceId={workspaceId}
        missionId={missionId}
      />
    );
  };

  if (isExpanded) {
    // Show all tools with a collapse button at the top
    return (
      <div className="space-y-2">
        <button
          onClick={onToggleExpand}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1 rounded-full",
            "bg-white/[0.02] border border-white/[0.04]",
            "text-white/30 hover:text-white/50 hover:bg-white/[0.04]",
            "transition-all duration-200 text-xs",
          )}
        >
          <ChevronUp className="h-3 w-3" />
          <span>
            Hide {hiddenCount} previous tool{hiddenCount > 1 ? "s" : ""}
          </span>
        </button>
        {tools.map((tool) => renderTool(tool))}
      </div>
    );
  }

  // Collapsed state - show expand button + last tool
  return (
    <div className="space-y-2">
      <button
        onClick={onToggleExpand}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-full",
          "bg-white/[0.02] border border-white/[0.04]",
          "text-white/30 hover:text-white/50 hover:bg-white/[0.04]",
          "transition-all duration-200 text-xs",
        )}
      >
        <ChevronDown className="h-3 w-3" />
        <span>
          Show {hiddenCount} previous tool{hiddenCount > 1 ? "s" : ""}
        </span>
      </button>
      {renderTool(lastTool)}
    </div>
  );
}

type ChatItemRowProps = {
  item: GroupedItem;
  highlighted: boolean;
  workspaceId: string | undefined;
  missionId: string | undefined;
  basePath: string | undefined;
  isToolGroupExpanded: boolean;
  onToggleToolGroup: (groupId: string) => void;
  onResume: () => void;
  onToolResult: (
    toolCallId: string,
    name: string,
    result: unknown,
  ) => Promise<void>;
  onOptimisticToolResult: (toolCallId: string, result: unknown) => void;
  /** Set of tool-call item ids whose plan card should render —
   *  passing it lets the row dedupe earlier plan-file writes (see
   *  `visiblePlanToolIds` memo in the parent). */
  visiblePlanToolIds?: Set<string>;
};

/**
 * Memoized row for the chat list. React.memo short-circuits when the
 * row's props are shallow-equal — the common SSE-tick case, where only
 * the tail of `items` is appended. Tool-group expansion is passed as a
 * plain boolean per row so toggling one group doesn't invalidate any
 * of the others.
 */
const ChatItemRow = memo(function ChatItemRow({
  item,
  highlighted,
  workspaceId,
  missionId,
  basePath,
  isToolGroupExpanded,
  onToggleToolGroup,
  onResume,
  onToolResult,
  onOptimisticToolResult,
  visiblePlanToolIds,
}: ChatItemRowProps) {
  const renderedContent =
    item.kind === "assistant" && item.sharedFiles?.length
      ? stripRichFileTagsByName(
          item.content,
          item.sharedFiles.flatMap((file) => [file.name, file.url]),
        )
      : item.kind === "assistant"
        ? item.content
        : "";

  if (item.kind === "tool_group") {
    return (
      <div
        id={`chat-item-${item.groupId}`}
        data-chat-item-id={item.groupId}
        className={cn(
          "rounded-xl transition-colors",
          highlighted && "ring-1 ring-amber-400/70 bg-amber-500/10",
        )}
      >
        <CollapsedToolGroup
          tools={item.tools}
          isExpanded={isToolGroupExpanded}
          onToggleExpand={() => onToggleToolGroup(item.groupId)}
          workspaceId={workspaceId}
          missionId={missionId}
          visiblePlanToolIds={visiblePlanToolIds}
        />
      </div>
    );
  }

  if (item.kind === "user") {
    return (
      <div
        id={`chat-item-${item.id}`}
        data-chat-item-id={item.id}
        className={cn(
          "flex justify-end gap-3 group rounded-xl transition-colors",
          highlighted && "ring-1 ring-amber-400/70 bg-amber-500/10",
        )}
      >
        <CopyButton text={item.content} className="self-start mt-2" />
        <div className="max-w-[85%]">
          <div
            className={cn(
              "rounded-2xl rounded-tr-md px-4 py-3 text-white selection-light",
              item.queued
                ? "border-2 border-dashed border-indigo-500/60 bg-indigo-500/20"
                : "bg-indigo-500",
            )}
          >
            <p className="whitespace-pre-wrap text-base leading-relaxed break-words">
              {item.content}
            </p>
          </div>
          <div className="mt-1 text-right flex items-center justify-end gap-2">
            {item.queued === true && (
              <span className="text-[10px] text-white/30">Queued</span>
            )}
            <span className="text-[10px] text-white/30">
              {formatTime(item.timestamp)}
            </span>
          </div>
        </div>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.08]">
          <User className="h-4 w-4 text-white/60" />
        </div>
      </div>
    );
  }

  if (item.kind === "assistant") {
    const turnStatus = deriveAssistantTurnStatus(item);
    // ServerShutdown turns auto-resume — render with the check icon so the
    // visual weight matches "this is being handled", not "agent died".
    const MessageStatusIcon =
      item.success || item.terminalReason === "ServerShutdown" ? CheckCircle : XCircle;
    const displayModel = item.model
      ? item.model.includes("/")
        ? item.model.split("/").pop()
        : item.model
      : null;
    return (
      <div
        id={`chat-item-${item.id}`}
        data-chat-item-id={item.id}
        className={cn(
          "flex justify-start gap-3 group rounded-xl transition-colors",
          highlighted && "ring-1 ring-amber-400/70 bg-amber-500/10",
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/20">
          <Bot className="h-4 w-4 text-indigo-400" />
        </div>
        <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white/[0.03] border border-white/[0.06] px-4 py-3 text-base leading-relaxed">
          <div className="mb-2 flex items-center gap-2 text-xs text-white/40">
            <MessageStatusIcon
              className={cn("h-3 w-3", turnStatus.iconClass)}
            />
            <span>{turnStatus.label}</span>
            {displayModel && (
              <>
                <span>•</span>
                <span
                  className="font-mono truncate max-w-[120px]"
                  title={item.model ?? undefined}
                >
                  {displayModel}
                </span>
              </>
            )}
            {(item.costSource !== "unknown" || item.costCents > 0) && (
              <>
                <span>•</span>
                <span
                  className={
                    item.costSource === "actual"
                      ? "text-emerald-400"
                      : item.costSource === "estimated"
                        ? "text-amber-300"
                        : "text-white/50"
                  }
                >
                  {item.costSource === "unknown"
                    ? item.costCents > 0
                      ? `$${(item.costCents / 100).toFixed(4)}`
                      : "N/A"
                    : `$${(item.costCents / 100).toFixed(4)}`}
                </span>
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/60">
                  {item.costSource === "actual"
                    ? "Actual"
                    : item.costSource === "estimated"
                      ? "Estimated"
                      : "Unknown"}
                </span>
              </>
            )}
            <span>•</span>
            <span className="text-white/30">{formatTime(item.timestamp)}</span>
          </div>
          {/* P2-#13: lazy markdown — bubbles render as raw text until they
              scroll near the viewport, then upgrade to full markdown. */}
          <LazyMarkdownContent
            content={renderedContent}
            basePath={basePath}
            workspaceId={workspaceId}
            missionId={missionId}
          />
          {item.sharedFiles && item.sharedFiles.length > 0 && (
            <div className="mt-2">
              {item.sharedFiles.map((file, idx) => (
                <SharedFileCard key={`${file.url}-${idx}`} file={file} />
              ))}
            </div>
          )}
          {turnStatus.showResume && item.resumable && (
            <div className="mt-3 flex gap-2">
              <button
                onClick={onResume}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors"
              >
                <RotateCcw className="h-3 w-3" />
                Resume Mission
              </button>
            </div>
          )}
        </div>
        <CopyButton text={item.content} className="self-start mt-8" />
      </div>
    );
  }

  if (item.kind === "phase") {
    return <PhaseItem item={item} />;
  }

  if (item.kind === "thinking_group") {
    return (
      <ThinkingGroupItem
        items={item.thoughts}
        basePath={basePath}
        workspaceId={workspaceId}
        missionId={missionId}
      />
    );
  }

  if (item.kind === "thinking" || item.kind === "stream") {
    return (
      <ThinkingGroupItem
        items={[item]}
        basePath={basePath}
        workspaceId={workspaceId}
        missionId={missionId}
      />
    );
  }

  if (item.kind === "tool") {
    if (item.isUiTool) {
      if (item.name === "question" || item.name === "AskUserQuestion") {
        return (
          <QuestionToolItem
            item={item}
            onSubmit={async (toolCallId, answers) => {
              onOptimisticToolResult(toolCallId, { answers });
              await onToolResult(toolCallId, item.name, { answers });
            }}
          />
        );
      }
      if (item.name === "ui_optionList") {
        const toolCallId = item.toolCallId;
        const rawArgs: Record<string, unknown> = isRecord(item.args)
          ? item.args
          : {};

        let optionList: ReturnType<typeof parseSerializableOptionList> | null =
          null;
        let parseErr: string | null = null;
        try {
          optionList = parseSerializableOptionList({
            ...rawArgs,
            id:
              typeof rawArgs["id"] === "string" && rawArgs["id"]
                ? (rawArgs["id"] as string)
                : `option-list-${toolCallId}`,
          });
        } catch (e) {
          parseErr =
            e instanceof Error ? e.message : "Invalid option list payload";
        }

        const confirmed = item.result as OptionListSelection | undefined;

        return (
          <div
            id={`chat-item-${item.id}`}
            data-chat-item-id={item.id}
            className="flex justify-start gap-3"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/20">
              <Bot className="h-4 w-4 text-indigo-400" />
            </div>
            <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white/[0.03] border border-white/[0.06] px-4 py-3 text-base leading-relaxed">
              <div className="mb-2 text-xs text-white/40">
                Tool:{" "}
                <span className="font-mono text-indigo-400">{item.name}</span>
              </div>

              {parseErr || !optionList ? (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
                  {parseErr ?? "Failed to render OptionList"}
                </div>
              ) : (
                <OptionListErrorBoundary>
                  <OptionList
                    {...optionList}
                    value={undefined}
                    confirmed={confirmed}
                    onConfirm={async (selection) => {
                      onOptimisticToolResult(toolCallId, selection);
                      await onToolResult(toolCallId, item.name, selection);
                    }}
                    onCancel={async () => {
                      onOptimisticToolResult(toolCallId, null);
                      await onToolResult(toolCallId, item.name, null);
                    }}
                  />
                </OptionListErrorBoundary>
              )}
            </div>
          </div>
        );
      }

      if (item.name === "ui_dataTable") {
        const rawArgs: Record<string, unknown> = isRecord(item.args)
          ? item.args
          : {};
        const dataTable = parseSerializableDataTable(rawArgs);

        return (
          <div
            id={`chat-item-${item.id}`}
            data-chat-item-id={item.id}
            className="flex justify-start gap-3"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/20">
              <Bot className="h-4 w-4 text-indigo-400" />
            </div>
            <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white/[0.03] border border-white/[0.06] px-4 py-3">
              <div className="mb-2 text-xs text-white/40">
                Tool:{" "}
                <span className="font-mono text-indigo-400">{item.name}</span>
              </div>
              {dataTable ? (
                <DataTable
                  id={dataTable.id}
                  title={dataTable.title}
                  columns={dataTable.columns}
                  rows={dataTable.rows}
                />
              ) : (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
                  Failed to render DataTable
                </div>
              )}
            </div>
          </div>
        );
      }

      return (
        <ToolCallItem
          item={item}
          highlighted={highlighted}
          workspaceId={workspaceId}
          missionId={missionId}
        />
      );
    }

    if (isSubagentTool(item.name)) {
      return <SubagentToolItem item={item} highlighted={highlighted} />;
    }

    // TodoWrite renders in the workbench panel (see AgentTasksPanel),
    // not as a chat card — see renderTool comment above.
    if (isTodoWriteTool(item.name)) {
      return null;
    }

    // Finalized-plan card with full-screen markdown modal.
    // Dedupe by file path so only the latest Write per
    // `.claude/plans/*.md` renders (see parent's
    // `visiblePlanToolIds` memo).
    if (isPlanTool(item.name, item.args)) {
      if (visiblePlanToolIds && !visiblePlanToolIds.has(item.id)) {
        return null;
      }
      return <PlanItem item={item} />;
    }

    return (
      <ToolCallItem
        item={item}
        highlighted={highlighted}
        workspaceId={workspaceId}
        missionId={missionId}
      />
    );
  }

  // system
  return (
    <div className="flex justify-start gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.04]">
        <Ban className="h-4 w-4 text-white/40" />
      </div>
      <div className="max-w-[80%] rounded-2xl rounded-tl-md bg-white/[0.02] border border-white/[0.04] px-4 py-3">
        <p className="whitespace-pre-wrap text-sm text-white/60 break-words">
          {item.content}
        </p>
        {item.resumable && (
          <div className="mt-3 flex gap-2">
            <button
              onClick={onResume}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors"
            >
              <RotateCcw className="h-3 w-3" />
              Resume Mission
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

// Attachment preview component
function AttachmentPreview({
  file,
  isUploading,
  onRemove,
}: {
  file: { name: string; type: string };
  isUploading?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06]">
      <Paperclip className="h-4 w-4 text-white/40" />
      <span className="text-sm text-white/70 truncate max-w-[200px]">
        {file.name}
      </span>
      {isUploading ? (
        <Loader className="h-3 w-3 animate-spin text-indigo-400" />
      ) : (
        onRemove && (
          <button
            onClick={onRemove}
            className="text-white/40 hover:text-white/70 transition-colors"
          >
            <XCircle className="h-4 w-4" />
          </button>
        )
      )}
    </div>
  );
}

export default function ControlClient() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [items, setItems] = useControlItemsStore();
  const itemsRef = useRef<ChatItem[]>([]);
  const [input, setInput] = useState(() => loadControlDraftForMission(null));
  const [canSubmitInput, setCanSubmitInput] = useState(false);
  const [lastMissionId, setLastMissionId] = useLocalStorage<string | null>(
    "control-last-mission-id",
    null,
  );

  const [viewingMissionSlice, setViewingMissionSlice] =
    useControlViewingMissionStore();
  const {
    currentMission,
    viewingMission,
    viewingMissionId,
    runState,
    runStateMissionId,
  } = viewingMissionSlice;
  const setCurrentMission = useCallback(
    (next: Mission | null | ((prev: Mission | null) => Mission | null)) => {
      setViewingMissionSlice((prev) => ({
        ...prev,
        currentMission:
          typeof next === "function" ? next(prev.currentMission) : next,
      }));
    },
    [setViewingMissionSlice],
  );
  const setViewingMission = useCallback(
    (next: Mission | null | ((prev: Mission | null) => Mission | null)) => {
      setViewingMissionSlice((prev) => ({
        ...prev,
        viewingMission:
          typeof next === "function" ? next(prev.viewingMission) : next,
      }));
    },
    [setViewingMissionSlice],
  );
  const setViewingMissionId = useCallback(
    (next: string | null | ((prev: string | null) => string | null)) => {
      setViewingMissionSlice((prev) => {
        const resolved =
          typeof next === "function" ? next(prev.viewingMissionId) : next;
        if (resolved !== prev.viewingMissionId) {
          console.log("[mission-switch]", {
            from: prev.viewingMissionId,
            to: resolved,
          });
        }
        return { ...prev, viewingMissionId: resolved };
      });
    },
    [setViewingMissionSlice],
  );
  const setRunState = useCallback(
    (next: ControlRunState | ((prev: ControlRunState) => ControlRunState)) => {
      setViewingMissionSlice((prev) => ({
        ...prev,
        runState: typeof next === "function" ? next(prev.runState) : next,
      }));
    },
    [setViewingMissionSlice],
  );
  const setRunStateMissionId = useCallback(
    (next: string | null | ((prev: string | null) => string | null)) => {
      setViewingMissionSlice((prev) => ({
        ...prev,
        runStateMissionId:
          typeof next === "function" ? next(prev.runStateMissionId) : next,
      }));
    },
    [setViewingMissionSlice],
  );
  const [queueLen, setQueueLen] = useControlQueueStore();
  const lastQueueLenRef = useRef<number | null>(null);
  const syncingQueueRef = useRef(false);

  // Backwards-pagination state. Long missions can have 20k+ history events
  // and the initial load is capped at HISTORY_PAGE_SIZE for memory + render
  // perf. These caches let the user click "Load older messages" to fetch
  // the next page back without re-fetching the whole history.
  //
  // missionMinSeqRef            — lowest `sequence` currently loaded; used
  //                               as the next `before_seq` cursor.
  // missionHistoricEventsRef    — accumulated raw history events for the
  //                               mission (initial + paginated older). Kept
  //                               so we can replay `eventsToItems` over the
  //                               full set when prepending older events,
  //                               which preserves tool_call/result linkage
  //                               and thinking-delta consolidation.
  // historicItemsCountRef       — number of items in `items` that came
  //                               from the current historic snapshot, so a
  //                               paginate-older replace knows where the
  //                               live SSE-appended tail starts.
  // missionTotalHistoryRef      — server-reported total count (matching
  //                               the type filter); compared against
  //                               accumulated cache size to decide whether
  //                               more older events exist.
  const missionMinSeqRef = useRef<Map<string, number>>(new Map());
  const missionHistoricEventsRef = useRef<Map<string, StoredEvent[]>>(
    new Map(),
  );
  const historicItemsCountRef = useRef<Map<string, number>>(new Map());
  const missionTotalHistoryRef = useRef<Map<string, number>>(new Map());
  // In-flight guard for backwards-paginate. The manual "Load older
  // messages" click and the post-initial background fill both advance
  // the `missionMinSeqRef` cursor; if they fire concurrently they'd
  // race on the same `before_seq` value and prepend duplicate events.
  // The set holds the mission ids currently mid-fetch.
  const paginatingOlderRef = useRef<Set<string>>(new Set());
  // Captured scroll geometry from the moment of `setItems` during a
  // paginate-back. Consumed by a `useLayoutEffect` watching `items` so the
  // restoration runs synchronously after commit but BEFORE the browser
  // paints — using `requestAnimationFrame` here would let the user see a
  // one-frame jump against the longer DOM before the scroll adjusts.
  const pendingScrollRestoreRef = useRef<{
    oldScrollTop: number;
    oldScrollHeight: number;
  } | null>(null);
  // Pagination UI state carries `missionId` so a stale-mission completion
  // (or a stuck `loading: true` from a fetch the user navigated away
  // from) can't surface on a different mission's button. The JSX reads
  // through `activeOlderLoadState` below, which only honors the state
  // when the recorded mission id matches what the user is currently
  // viewing — otherwise it falls back to the safe defaults
  // (`hasMore=false`, `loading=false`).
  const [olderLoadState, setOlderLoadState] = useState<{
    missionId: string | null;
    hasMore: boolean;
    loading: boolean;
  }>({ missionId: null, hasMore: false, loading: false });

  // Performance optimization: limit rendered items for large conversations
  const INITIAL_VISIBLE_ITEMS = 30;
  const [visibleItemsLimit, setVisibleItemsLimit] = useState(
    INITIAL_VISIBLE_ITEMS,
  );
  // Store items per mission to preserve context when switching.
  const [missionItems, setMissionItems] = useState<Record<string, ChatItem[]>>(
    {},
  );

  // Memory pressure safety valve. Long-running missions (25k+ events, each
  // with large tool_result payloads) have crashed the Brave/Chrome tab with
  // "Can't open this page / Error code: 5" — a renderer OOM. The per-mission
  // 5k event cap on the initial fetch isn't enough on its own because each
  // tool_result can carry 100 KB+ of bash output. When `MissionDebugStats`
  // reports a heap above ~1.2 GB, we trim `items` down to the most recent
  // slice so the tab recovers instead of the user losing the whole session.
  //
  // Thresholds tuned against the observed crash profile (~1.5 GB heap before
  // renderer exit): shed at 1.2 GB, keep the last 1500 items, and log so it's
  // obvious in DevTools that trimming happened. Below-threshold ticks don't
  // touch state at all.
  useEffect(() => {
    const SHED_HEAP_BYTES = 1_200_000_000;
    const KEEP_TAIL_ITEMS = 1500;
    function onStats(ev: Event) {
      const detail = (ev as CustomEvent).detail as
        | { heap?: { usedJSHeapSize?: number }; itemsCount?: number }
        | undefined;
      const used = detail?.heap?.usedJSHeapSize ?? 0;
      if (used < SHED_HEAP_BYTES) return;
      setItems((prev) => {
        if (prev.length <= KEEP_TAIL_ITEMS) return prev;
        console.warn(
          `[mission-debug] heap ${(used / 1_048_576).toFixed(0)} MB exceeded ` +
            `${SHED_HEAP_BYTES / 1_048_576} MB; trimming items ` +
            `${prev.length} → ${KEEP_TAIL_ITEMS}`,
        );
        return prev.slice(-KEEP_TAIL_ITEMS);
      });
      // Also trim every per-mission cache entry that exceeds the
      // threshold, not just the one whose live `items` we just
      // trimmed. The cache can be larger than current `items` from a
      // prior snapshot (e.g. after a mission switch), so this must
      // not depend on whether the live trim happened.
      setMissionItems((prev) => {
        let changed = false;
        const next: Record<string, ChatItem[]> = {};
        for (const [id, cached] of Object.entries(prev)) {
          if (cached.length > KEEP_TAIL_ITEMS) {
            next[id] = cached.slice(-KEEP_TAIL_ITEMS);
            changed = true;
          } else {
            next[id] = cached;
          }
        }
        return changed ? next : prev;
      });
    }
    window.addEventListener("mission-debug-stats", onStats);
    return () => window.removeEventListener("mission-debug-stats", onStats);
  }, [setItems, setMissionItems]);

  // Connection state for SSE stream - starts as disconnected until first event received
  const [connectionState, setConnectionState] = useState<
    "connected" | "disconnected" | "reconnecting"
  >("disconnected");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [showStreamDiagnostics, setShowStreamDiagnostics] = useState(false);
  const [streamDiagnostics, setStreamDiagnostics] =
    useControlStreamingDiagnosticsStore();
  const [diagTick, setDiagTick] = useState(0);

  // Progress state (for "Subtask X of Y" indicator), tracked per mission
  const [progressByMission, setProgressByMission] = useState<
    Record<
      string,
      {
        total: number;
        completed: number;
        current: string | null;
        depth: number;
      }
    >
  >({});

  // Mission state lives in `controlViewingMissionStore`; these local states
  // cover lower-churn loading/list UI around it.
  const [missionLoading, setMissionLoading] = useState(false);
  const [recentMissions, setRecentMissions] = useState<Mission[]>([]);
  const [dismissedResumeUI, setDismissedResumeUI] = useState(false);

  // Workspaces for mission creation
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  // Library context for agents

  // Only tick when stream is active to avoid unnecessary re-renders
  const streamIsActive =
    streamDiagnostics.phase === "open" ||
    streamDiagnostics.phase === "streaming" ||
    streamDiagnostics.phase === "connecting";
  useEffect(() => {
    if (!streamIsActive) return;
    const interval = setInterval(() => setDiagTick((prev) => prev + 1), 1000);
    return () => clearInterval(interval);
  }, [streamIsActive]);

  // Per-mission docker-compose service state, keyed by mission_id.
  // Populated by the `mission_docker_status` SSE event (server pushes
  // diffs on every dockerd container/health event). Read by the
  // DockerServicesPanel in the workbench column.
  const [dockerServicesByMission, setDockerServicesByMission] = useState<
    Record<string, import("@/lib/api").DockerServiceStatus[]>
  >({});

  // Sub-agent (Claude Code `Agent` tool sidechain) activity, keyed
  // by parent_tool_use_id. Each entry is the chronological list of
  // tool calls / results / text emitted by that sub-agent. Fed by
  // the `subagent_tool_call` / `subagent_tool_result` /
  // `subagent_text` SSE events. Read by the SubagentTabs strip and
  // the per-tab chat view that replaces the main thread when a
  // sub-agent tab is active.
  type SubagentActivity =
    | {
        kind: "tool_call";
        tool_call_id: string;
        name: string;
        args: unknown;
        ts: number;
      }
    | {
        kind: "tool_result";
        tool_call_id: string;
        name: string;
        result: unknown;
        ts: number;
      }
    | { kind: "text"; content: string; ts: number };
  const [subagentActivityByParent, setSubagentActivityByParent] = useState<
    Record<string, SubagentActivity[]>
  >({});

  // Which sub-agent tab is currently focused.
  // `null` = the boss's main thread (default).
  // A string value = parent_tool_use_id of the focused sub-agent.
  // Reset to null whenever the viewed mission changes (see effect below).
  const [activeSubagentTab, setActiveSubagentTab] = useState<string | null>(
    null,
  );

  // Parallel missions state
  // (sub-agent tab is reset when the viewed mission changes — see effect below)
  const [runningMissions, setRunningMissions] = useState<RunningMissionInfo[]>(
    [],
  );
  const [showMissionSwitcher, setShowMissionSwitcher] = useState(false);
  // Sub-agents panel (in-mission Agent / Task / spawn_agent tool calls)
  // has its own open/closed state. Per-mission dismissal so a fresh
  // sub-agent doesn't auto-reopen after the user closed it.
  const [showSubagentsPanel, setShowSubagentsPanel] = useState(true);
  const subagentsPanelDismissedRef = useRef<Set<string>>(new Set());
  // Agent-tasks panel (TodoWrite list) — separate sidebar instead
  // of being baked into the workbench card.
  const [showAgentTasksPanel, setShowAgentTasksPanel] = useState(false);
  const agentTasksPanelDismissedRef = useRef<Set<string>>(new Set());
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(
    null,
  );
  const deepLinkFocusKeyRef = useRef<string | null>(null);
  const [showAutomationsDialog, setShowAutomationsDialog] = useState(false);

  // Track which mission's events we're viewing (for parallel missions).
  // This can differ from currentMission when viewing a parallel mission; the
  // value itself lives in `controlViewingMissionStore`.

  // Limit mission item caches to prevent memory bloat.
  const MAX_CACHED_MISSIONS = 5;

  // Helper to update missionItems with LRU-style cleanup
  const updateMissionItems = useCallback(
    (missionId: string, items: ChatItem[]) => {
      setMissionItems((prev) => {
        const updated = { ...prev, [missionId]: items };
        const keys = Object.keys(updated);
        // If over limit, remove oldest entries (first in object)
        if (keys.length > MAX_CACHED_MISSIONS) {
          const toRemove = keys.slice(0, keys.length - MAX_CACHED_MISSIONS);
          toRemove.forEach((k) => delete updated[k]);
        }
        return updated;
      });
    },
    [],
  );

  const [uploadQueue, setUploadQueue] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{
    fileName: string;
    progress: UploadProgress;
  } | null>(null);

  // Server configuration (fetched from health endpoint)
  const [maxIterations, setMaxIterations] = useState<number>(50); // Default fallback

  // Desktop stream state
  const [showDesktopStream, setShowDesktopStream] = useState(false);
  const [desktopDisplayId, setDesktopDisplayId] = useState(":99");
  const desktopDisplayIdRef = useRef(":99");
  const [showDisplaySelector, setShowDisplaySelector] = useState(false);
  const [hasDesktopSession, setHasDesktopSession] = useState(false);
  const [desktopSessions, setDesktopSessions] = useState<
    DesktopSessionDetail[]
  >([]);
  const desktopSessionsRef = useRef<DesktopSessionDetail[]>([]);
  const hasDesktopSessionRef = useRef(false);
  const [isClosingDesktop, setIsClosingDesktop] = useState<string | null>(null);
  // Track when we're expecting a desktop session (from ToolCall before ToolResult arrives)
  const expectingDesktopSessionRef = useRef(false);
  const desktopRapidPollRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  const [showWorkbenchPanel, setShowWorkbenchPanel] = useState(
    () => searchParams.get("workbench") === "1",
  );
  // Changes panel — fetches per-mission git status + diff inside the
  // K8sPod's repos. Off by default; click the Changes tab in the
  // sub-agent strip to open. Reset to closed when the viewed mission
  // changes (a different mission has its own changes set).
  const [showChangesPanel, setShowChangesPanel] = useState(false);
  // Pending "open this file at line N" request, set by the chat's
  // file-ref linkifier. ChangesPanel consumes it on next render
  // and acks via onPendingOpenConsumed.
  const [pendingFileRef, setPendingFileRef] = useState<
    { repo: string; path: string; line?: number } | null
  >(null);

  // Cmd-Shift-[ / Cmd-Shift-] cycle through the mission tab bar
  // (active non-terminal missions only). Skips when a modal is
  // the topmost overlay or when focus is in a text input — we
  // don't want to hijack the bracket keys in the composer or
  // any modal form field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key !== "[" && e.key !== "]" && e.key !== "{" && e.key !== "}") {
        return;
      }
      // `[`/`]` arrive as `{`/`}` on some layouts because Shift
      // is held. Treat all four as the same control.
      const dir = e.key === "[" || e.key === "{" ? -1 : 1;
      // Bail when a modal is open. Monaco's own keybindings also
      // claim Cmd-Shift-[ for fold, so we leave focus alone when
      // the user is inside the editor.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
        return;
      }
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // Skip Monaco — it has its own bracket-key bindings.
      if (document.activeElement?.closest(".monaco-editor")) return;
      e.preventDefault();
      const tabs = recentMissions.filter(
        (m) => !isFinishedStatus(m.status),
      );
      if (tabs.length === 0) return;
      const cur = viewingMissionId
        ? tabs.findIndex((m) => m.id === viewingMissionId)
        : -1;
      const next =
        cur === -1
          ? (dir === 1 ? 0 : tabs.length - 1)
          : (cur + dir + tabs.length) % tabs.length;
      handleViewMission(tabs[next].id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentMissions, viewingMissionId]);

  // Esc-Esc → checkpoint modal (Claude Code-style "restore
  // conversation to here"). lastEscRef holds the timestamp of
  // the previous Escape press; a second Escape within 500 ms
  // opens the modal.
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const lastEscRef = useRef<number>(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Suppress Esc-Esc when another modal is the topmost UI —
      // first Esc closes that modal, second Esc shouldn't pop
      // ours on top. The CSS scrim has z-[70+] / role="dialog";
      // we look for either.
      const overlay = document.querySelector(
        '[role="dialog"][aria-modal="true"]',
      );
      if (overlay) {
        lastEscRef.current = 0;
        return;
      }
      const now = Date.now();
      if (now - lastEscRef.current < 500) {
        lastEscRef.current = 0;
        setShowRestoreModal(true);
      } else {
        lastEscRef.current = now;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // Bus subscription: when the chat dispatches a file-ref click,
  // open the editor modal and queue the target for ChangesPanel.
  useEffect(() => {
    return onFileRef((target) => {
      setPendingFileRef(target);
      setShowChangesPanel(true);
    });
  }, []);
  const adjustVisibleItemsLimit = useCallback((historyItems: ChatItem[]) => {
    let lastAssistantIdx = -1;
    for (let i = historyItems.length - 1; i >= 0; i--) {
      if (historyItems[i].kind === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }

    if (lastAssistantIdx === -1) {
      setVisibleItemsLimit(INITIAL_VISIBLE_ITEMS);
      return;
    }

    const required = historyItems.length - lastAssistantIdx;
    if (required <= INITIAL_VISIBLE_ITEMS) {
      setVisibleItemsLimit(INITIAL_VISIBLE_ITEMS);
      return;
    }

    setVisibleItemsLimit(required);
  }, []);

  const HISTORY_EVENT_TYPES = useMemo(
    () => [
      "user_message",
      "assistant_message",
      "assistant_message_canonical",
      "tool_call",
      "tool_result",
      "text_delta",
      "text_op",
      "thinking",
      // Goal-mode events fed into goalInfoByMission on hydration so the
      // pill renders on a fresh page load instead of waiting for the
      // next live SSE update.
      "goal_iteration",
      "goal_status",
    ],
    [],
  );
  /**
   * Per-mission high-water mark for `sequence`. When non-zero, reload
   * paths pass it as `since_seq` to `/events` so the server returns
   * only the tail that arrived while we were disconnected, not the
   * whole history. The backend's own `sequence` column is monotonic
   * per-mission (see mission_store/sqlite.rs), so a simple ordered
   * compare is enough.
   */
  const missionMaxSeqRef = useRef<Map<string, number>>(new Map());

  // Page size for each backwards-paginate-older fetch (both the explicit
  // "Load older messages" button and the post-initial background fill).
  // Tuned for memory headroom on long missions — see the
  // `chatScrollContainerRef` comment block above.
  const HISTORY_PAGE_SIZE = 5000;
  // Cap how far the background fill walks back from the head on first load.
  // Past this depth the user has to click "Load older messages" — keeps
  // memory + render cost predictable on huge missions while still feeling
  // "complete" for typical ones.
  const BACKGROUND_FILL_TARGET = 2000;
  // Per-page size used by the background fill. Smaller than the explicit
  // "Load older" button so each chunk costs less and we can interleave with
  // live SSE events without long main-thread stalls.
  const BACKGROUND_FILL_PAGE_SIZE = 500;

  const loadHistoryEvents = useCallback(
    async (id: string, opts?: { sinceSeq?: number }) => {
      if (opts?.sinceSeq !== undefined) {
        // Delta load — used on reconnect/visibility/periodic sync.
        // The server returns events with sequence > sinceSeq already
        // ordered ASC, so we don't need to re-sort client-side.
        const { events, meta } = await getMissionEventsWithMeta(id, {
          types: HISTORY_EVENT_TYPES,
          sinceSeq: opts.sinceSeq,
          limit: HISTORY_PAGE_SIZE,
        });
        const maxSequence = meta.maxSequence ?? opts.sinceSeq;
        // If the page was capped by `limit`, advance the cursor to the
        // last returned event's sequence instead of `meta.maxSequence` —
        // otherwise the next poll would skip every event between the
        // returned tail and the true max.
        const lastSeq =
          events.length > 0
            ? events[events.length - 1].sequence
            : opts.sinceSeq;
        const cursor =
          events.length >= HISTORY_PAGE_SIZE && lastSeq < maxSequence
            ? lastSeq
            : maxSequence;
        missionMaxSeqRef.current.set(id, cursor);
        return events;
      }

      let sorted: StoredEvent[] | null = null;
      let metaMaxSeq: number | undefined;
      let metaTotal: number | undefined;

      const cached = await readCachedEvents(id).catch(() => null);
      let cacheHit = false;
      let eventMergeCount = 0;
      if (cached && cached.events.length > 0) {
        try {
          const delta = await getMissionEventsWithMeta(id, {
            types: HISTORY_EVENT_TYPES,
            sinceSeq: cached.maxSequence,
            limit: HISTORY_PAGE_SIZE,
          });
          // If the server's max sequence is *behind* what we cached, the
          // mission was reset or replaced server-side and our cache is
          // bogus — drop it and reload fresh.
          if ((delta.meta.maxSequence ?? 0) >= cached.maxSequence) {
            // Merge cached tail + delta. Both are sorted by sequence;
            // dedup defensively in case the server re-sent an overlap row.
            const seen = new Set<number>();
            const merged: StoredEvent[] = [];
            for (const ev of cached.events) {
              if (!seen.has(ev.sequence)) {
                seen.add(ev.sequence);
                merged.push(ev);
              }
            }
            for (const ev of delta.events) {
              if (!seen.has(ev.sequence)) {
                seen.add(ev.sequence);
                merged.push(ev);
              }
            }
            merged.sort((a, b) => a.sequence - b.sequence);
            sorted = merged;
            metaMaxSeq = delta.meta.maxSequence;
            metaTotal = delta.meta.totalEvents;
            cacheHit = true;
            eventMergeCount = merged.length;
          }
        } catch {
          // Network or auth failure on the delta — fall through to the
          // fresh `latest` fetch path. The cache row stays so a future
          // reopen can try again.
        }
      }

      if (!sorted) {
        try {
          const snapshot = await getMissionSnapshot(id);
          sorted = snapshot.events.sort((a, b) => a.sequence - b.sequence);
          metaMaxSeq = snapshot.latest_sequence;
          metaTotal = snapshot.total_events;
          eventMergeCount = sorted.length;
        } catch {
          const fallback = await getMissionEventsWithMeta(id, {
            types: HISTORY_EVENT_TYPES,
            limit: HISTORY_PAGE_SIZE,
          });
          sorted = fallback.events.sort((a, b) => a.sequence - b.sequence);
          metaMaxSeq = fallback.meta.maxSequence;
          metaTotal = fallback.meta.totalEvents;
          eventMergeCount = sorted.length;
        }
      }

      if (metaMaxSeq !== undefined && metaMaxSeq > 0) {
        missionMaxSeqRef.current.set(id, metaMaxSeq);
      }
      perfBus.updateDiagnostics({
        missionId: id,
        maxSequence: metaMaxSeq,
        cacheHit,
        eventMergeCount,
      });
      // Seed pagination caches: snapshot of historic events, lowest seq
      // (cursor for next backwards page), and total filtered count from
      // the server (so we know when the user has reached the start).
      missionHistoricEventsRef.current.set(id, sorted);
      if (sorted.length > 0) {
        missionMinSeqRef.current.set(id, sorted[0].sequence);
      } else {
        missionMinSeqRef.current.delete(id);
      }
      if (metaTotal !== undefined) {
        missionTotalHistoryRef.current.set(id, metaTotal);
      } else {
        missionTotalHistoryRef.current.delete(id);
      }

      // Persist the freshly-loaded tail to the IDB cache so the next
      // reopen hits the fast path. Best-effort — write failures are
      // silently ignored.
      if (
        metaMaxSeq !== undefined &&
        metaMaxSeq > 0 &&
        metaTotal !== undefined &&
        sorted.length > 0
      ) {
        void writeCachedEvents(id, sorted, metaMaxSeq, metaTotal).catch(
          () => undefined,
        );
      }

      // Kick off the background fill so the rest of the history streams in
      // after first paint. Scheduled via setTimeout(0) so the caller's
      // setItems/render commits first — running the next fetch synchronously
      // here would just stall the same task we tried to free up. The ref
      // indirection breaks TDZ against `streamOlderHistory`, which is
      // declared after the older-paginator below.
      const hasMoreLocal = metaTotal !== undefined && sorted.length < metaTotal;
      if (hasMoreLocal) {
        const fillFn = streamOlderHistoryRef.current;
        if (fillFn) {
          setTimeout(() => {
            void fillFn(id);
          }, 0);
        }
      }
      return sorted;
    },
    [HISTORY_EVENT_TYPES],
  );

  // Bridge between `loadHistoryEvents` (declared above) and
  // `streamOlderHistory` (declared below). `loadHistoryEvents` schedules
  // the background fill at the tail end of its initial-load branch, but
  // can't reference `streamOlderHistory` by name without a TDZ violation.
  const streamOlderHistoryRef = useRef<((id: string) => Promise<void>) | null>(
    null,
  );

  /**
   * Recompute "is there more older history to load" for a mission, by
   * comparing the locally-cached event count against the server's total.
   */
  const computeHasMoreOlder = useCallback((id: string): boolean => {
    const accumulated = missionHistoricEventsRef.current.get(id)?.length ?? 0;
    const total = missionTotalHistoryRef.current.get(id) ?? 0;
    return accumulated < total;
  }, []);

  /**
   * Bookkeeping after an initial history load completes and `setItems`
   * has been called. Records how many items were derived from history
   * (so a later "load older" page-replace can find the live tail) and
   * publishes the "more older messages exist" state to the UI.
   */
  // `historyItemsLen` MUST count only the history-derived prefix
  // (event replay plus any coarse mission-history fallback), NOT the
  // post-queue-merge length. `loadOlderHistoryEvents` later splices via
  // `prev.slice(oldHistoricCount)`; if queued messages were counted
  // here, they'd land before the splice point, get rebuilt by
  // `eventsToItems` (which doesn't see queued messages), and silently
  // disappear from the UI on the next page-back.
  const seedPaginationStateAfterInitialLoad = useCallback(
    (id: string, historyItemsLen: number) => {
      historicItemsCountRef.current.set(id, historyItemsLen);
      setOlderLoadState({
        missionId: id,
        hasMore: computeHasMoreOlder(id),
        loading: false,
      });
    },
    [computeHasMoreOlder],
  );

  // `loadOlderHistoryEvents` is declared further down, after
  // `eventsToItems` (TDZ). Search for its definition there.

  // Tool groups expansion state - tracks which groups are expanded by their first tool's id
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(
    new Set(),
  );

  // Single O(n) pass derives every downstream view. Replaces 7 separate
  // `useMemo` hooks that each looped over `items` (see `deriveItemViews`
  // for the rationale).
  const { lastNonQueuedItem, groupedItems } = useMemo(
    () =>
      perfBus.time("replay:group", () => {
        const views = deriveItemViews(items);
        perfBus.updateDiagnostics({ renderCount: views.groupedItems.length });
        return views;
      }),
    [items],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const chatVirtualizer = useVirtualizer({
    count: groupedItems.length,
    getScrollElement: () => containerRef.current,
    getItemKey: (index) => {
      const item = groupedItems[index];
      return item ? getGroupedItemKey(item) : index;
    },
    estimateSize: (index) => {
      const item = groupedItems[index];
      if (!item) return 160;
      if (item.kind === "user") return 96;
      if (item.kind === "assistant") return 180;
      if (item.kind === "tool_group") return 160;
      if (item.kind === "thinking_group") return 120;
      if (item.kind === "tool") return 140;
      return 100;
    },
    overscan: 8,
    // Disable internal flushSync. TanStack Virtual calls flushSync
    // inside lifecycle methods (scroll, measure, unmount) which
    // React 19 flags as illegal — and during an unmount commit
    // the synchronous re-render races with React's deletion
    // traversal, producing the "Cannot read properties of null
    // (reading 'removeChild')" loop on navigation away from this
    // page. See TanStack/virtual#1094 + kubetail-org/kubetail#1003.
    useFlushSync: false,
  });
  // Suppress tanstack-virtual's automatic scroll-offset compensation.
  // Default behavior: every time an item above the viewport measures and
  // differs from its estimate, the virtualizer calls `_scrollToOffset`
  // to shift `scrollTop` by the delta. Six or seven of these can fire in
  // a single frame after the user scrolls up into a freshly-rendered
  // region, and the user perceives the scrollbar sliding back toward
  // the bottom while they're trying to read. Returning `false` from
  // this hook stops the per-item shifts; bottom pinning (when the user
  // is at the bottom) is already handled by `useVirtualTimelineAnchor`'s
  // `scheduleBottomCorrection`, so we don't need both forces fighting.
  // This is an instance field on the Virtualizer, not part of
  // `useVirtualizer`'s typed options — hence the direct assignment.
  chatVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  const showAgentWorkingIndicator = useMemo(() => {
    if (items.length === 0) return false;
    if (items[items.length - 1]?.kind === "assistant") return false;
    return !items.some(
      (it) =>
        ((it.kind === "thinking" || it.kind === "stream") && !it.done) ||
        it.kind === "phase",
    );
  }, [items]);
  const chatAnchorKey = useMemo(
    () =>
      groupedItems
        .slice(-8)
        .map((item) => {
          const key = getGroupedItemKey(item);
          if (item.kind === "thinking_group") {
            const tailThoughts = item.thoughts.slice(-4);
            return `${key}:${item.thoughts.length}:${tailThoughts.map((thought) => `${thought.id}:${thought.done ? "done" : "active"}:${thought.content.length}`).join(",")}`;
          }
          if (item.kind === "tool_group") {
            // Include each tool's running/done state AND a short
            // hash of the result content length so the anchor key
            // changes when tools finish or their stdout grows.
            // Without this, completed tools and live tool_results
            // wouldn't trigger the auto-scroll-to-bottom layout
            // effect and the user has to scroll manually.
            const tailTools = item.tools.slice(-6);
            const fp = tailTools
              .map((t) => {
                const r = t.result;
                const rLen =
                  typeof r === "string"
                    ? r.length
                    : r === undefined
                      ? 0
                      : JSON.stringify(r).length;
                return `${t.id}:${r === undefined ? "running" : "done"}:${rLen}`;
              })
              .join(",");
            return `${key}:${item.tools.length}:${fp}`;
          }
          if (item.kind === "thinking" || item.kind === "stream") {
            return `${key}:${item.done ? "done" : "active"}:${item.content.length}`;
          }
          if (item.kind === "assistant" || item.kind === "user") {
            return `${key}:${item.content.length}`;
          }
          if (item.kind === "tool") {
            // Single-tool item (not grouped) — same idea as
            // tool_group but for one entry.
            const r = item.result;
            const rLen =
              typeof r === "string"
                ? r.length
                : r === undefined
                  ? 0
                  : JSON.stringify(r).length;
            return `${key}:${r === undefined ? "running" : "done"}:${rLen}`;
          }
          return key;
        })
        .join("|") + `|w:${showAgentWorkingIndicator ? 1 : 0}`,
    [groupedItems, showAgentWorkingIndicator],
  );
  const { isAtBottom, scrollToBottom } = useVirtualTimelineAnchor({
    scrollElementRef: containerRef,
    virtualizer: chatVirtualizer,
    itemCount: groupedItems.length,
    changeKey: chatAnchorKey,
    resetKey: viewingMissionId,
  });

  useEffect(() => {
    desktopSessionsRef.current = desktopSessions;
  }, [desktopSessions]);

  useEffect(() => {
    desktopDisplayIdRef.current = desktopDisplayId;
  }, [desktopDisplayId]);

  useEffect(() => {
    hasDesktopSessionRef.current = hasDesktopSession;
  }, [hasDesktopSession]);

  // Mission switch — wipe every state slice that's mission-bound
  // but lives in this parent component (state slices INSIDE the
  // `<MissionScope key={missionId}>` subtree get reset automatically
  // via React unmount; this effect covers the slices that haven't
  // been lifted yet — see ~/.claude/plans/ok-now-i-want-witty-raccoon.md
  // Phases 2–7).
  //
  // Goal: no DOM/observable/event/state from the previous mission
  // survives into the new one. The existing draft swap effect at
  // line 6773 (saves old composer draft, loads new) handles input.
  // This handler adds: items (Zustand store), subagent state,
  // expanded tool groups, pending file refs, modal flags, streaming
  // delta buffers, flush timers.
  useEffect(() => {
    setActiveSubagentTab(null);
    setSubagentActivityByParent({});
    setShowChangesPanel(false);
    setShowRestoreModal(false);
    setExpandedToolGroups(new Set());
    setPendingFileRef(null);
    setItems([]);
    itemsRef.current = [];
    if (thinkingFlushTimeoutRef.current) {
      clearTimeout(thinkingFlushTimeoutRef.current);
      thinkingFlushTimeoutRef.current = null;
    }
    if (thinkingFlushRafRef.current !== null) {
      cancelAnimationFrame(thinkingFlushRafRef.current);
      thinkingFlushRafRef.current = null;
    }
    if (streamFlushTimeoutRef.current) {
      clearTimeout(streamFlushTimeoutRef.current);
      streamFlushTimeoutRef.current = null;
    }
    if (streamFlushRafRef.current !== null) {
      cancelAnimationFrame(streamFlushRafRef.current);
      streamFlushRafRef.current = null;
    }
    pendingThinkingRef.current = null;
    pendingStreamRef.current = null;
  }, [viewingMissionId, setItems]);

  // Tell the backend the user opened this mission. The server records
  // `first_viewed_at` on the first call (starting the 1h ack grace timer
  // for `awaiting_user` missions and painting the "opened" dot for
  // Finished missions); later calls are no-ops on the server. Fire-and-
  // forget — failure to record opening is not user-visible.
  useEffect(() => {
    if (!viewingMissionId) return;
    markMissionOpened(viewingMissionId).catch((err) => {
      console.warn("markMissionOpened failed", err);
    });
  }, [viewingMissionId]);

  // `groupedItems`, `thinkingItems`, etc. are all produced in the single
  // `deriveItemViews` pass above. The old per-view `useMemo` hooks used
  // to live here and have been removed.

  const runningMissionById = useMemo(() => {
    return new Map(runningMissions.map((m) => [m.mission_id, m]));
  }, [runningMissions]);

  const viewingRunningInfo = useMemo(() => {
    if (!viewingMissionId) return null;
    return runningMissionById.get(viewingMissionId) ?? null;
  }, [runningMissionById, viewingMissionId]);

  const viewingRunState = useMemo<ControlRunState>(() => {
    if (!viewingMissionId) return "idle";
    if (viewingRunningInfo) {
      if (viewingRunningInfo.state === "waiting_for_tool")
        return "waiting_for_tool";
      if (
        viewingRunningInfo.state === "queued" ||
        viewingRunningInfo.state === "running"
      ) {
        return "running";
      }
      return "idle";
    }
    if (runStateMissionId === viewingMissionId) {
      return runState;
    }
    return "idle";
  }, [viewingMissionId, viewingRunningInfo, runStateMissionId, runState]);

  const viewingQueueLen = useMemo(() => {
    if (!viewingMissionId) return 0;
    if (viewingRunningInfo) return viewingRunningInfo.queue_len;
    if (runStateMissionId === viewingMissionId) return queueLen;
    return 0;
  }, [viewingMissionId, viewingRunningInfo, runStateMissionId, queueLen]);

  const viewingMissionIsRunning = useMemo(() => {
    if (!viewingMissionId) return false;
    if (viewingRunningInfo) {
      return (
        viewingRunningInfo.state === "running" ||
        viewingRunningInfo.state === "waiting_for_tool" ||
        viewingRunningInfo.state === "queued"
      );
    }
    if (runStateMissionId === viewingMissionId) {
      return runState !== "idle";
    }
    return false;
  }, [viewingMissionId, viewingRunningInfo, runStateMissionId, runState]);

  const viewingProgress = useMemo(() => {
    if (!viewingMissionId) return null;
    return progressByMission[viewingMissionId] ?? null;
  }, [progressByMission, viewingMissionId]);

  useEffect(() => {
    if (items.length === 0) return;
    let lastAssistantIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx === -1) return;
    const visibleStart = Math.max(0, items.length - visibleItemsLimit);
    if (lastAssistantIdx < visibleStart) {
      setVisibleItemsLimit(items.length - lastAssistantIdx);
    }
  }, [items, visibleItemsLimit]);

  const viewingMissionStallInfo = useMemo(() => {
    if (!viewingMissionId) return null;
    if (!viewingRunningInfo) return null;
    if (viewingRunningInfo.health?.status !== "stalled") return null;
    // Suppress the stall banner only when the mission is in a truly
    // terminal DB state (completed/failed/not_feasible). The backend's
    // in-memory running-list can lag behind the DB (e.g. stale-cleanup
    // marked the mission Completed but the orphan runner task never
    // resolved), and nagging the user about a mission that's actually
    // done is worse than missing a genuine stall. Interrupted/blocked
    // are *not* terminal — they need user action — so a mission
    // stalled in one of those states should keep showing the banner.
    const status = viewingMission?.status;
    if (status && isFinishedStatus(status)) {
      return null;
    }
    return viewingRunningInfo.health;
  }, [viewingMissionId, viewingRunningInfo, viewingMission?.status]);

  const pendingUserInputItem = useMemo(() => {
    // Find the index of the last user message — any question before it is
    // implicitly answered (the user continued the conversation).
    let lastUserIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === "user") {
        lastUserIdx = i;
        break;
      }
    }
    // Only consider prompts that appear AFTER the last user message
    // and have no result — these are genuinely pending.
    for (let i = items.length - 1; i > lastUserIdx; i--) {
      const item = items[i];
      if (isPendingUserInputTool(item)) return item;
    }
    return null;
  }, [items]);
  const hasPendingUserInput = pendingUserInputItem !== null;

  const handleShowPendingUserInput = useCallback(() => {
    if (!pendingUserInputItem) return;
    const el = document.getElementById(`chat-item-${pendingUserInputItem.id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const index = groupedItems.findIndex(
      (item) => item.kind === "tool" && item.id === pendingUserInputItem.id,
    );
    if (index >= 0) {
      chatVirtualizer.scrollToIndex(index, { align: "center" });
    }
  }, [chatVirtualizer, groupedItems, pendingUserInputItem]);

  const viewingMissionStallSeconds =
    viewingMissionStallInfo?.seconds_since_activity ?? 0;
  const isViewingMissionStalled = Boolean(viewingMissionStallInfo);
  const isViewingMissionSeverelyStalled =
    viewingMissionStallInfo?.severity === "severe";

  // Treat "waiting_for_tool" as not busy for message input (user should respond immediately)
  const isBusy = viewingRunState === "running";
  const canSubmitComposer = canSubmitInput || input.trim().length > 0;

  // Goal-mode state, keyed by mission id. Updated from `goal_iteration` /
  // `goal_status` SSE events. Cleared when status reaches a terminal value
  // (`complete`, `cleared`, `budgetLimited`) so finished goals stop showing
  // a pill on subsequent renders.
  const [goalInfoByMission, setGoalInfoByMission] = useState<
    Record<string, { iteration: number; status: string; objective: string }>
  >({});

  const streamCleanupRef = useRef<null | (() => void)>(null);
  const enhancedInputRef = useRef<EnhancedInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Reconnect the SSE stream with the freshest mission filter. Set by the
   * stream effect; called from the per-mission switcher effect. Ref-based so
   * the SSE useEffect can keep its empty deps array. */
  const reconnectStreamRef = useRef<(() => void) | null>(null);
  /** Wall-clock timestamp (ms) of the last SSE event we received. The 15s
   * "running mission" history reload (P1-#5) checks this and skips the
   * refetch when the SSE stream is fresh — saves a 5000-row /events trip
   * (and the longtask that comes with it) on every running mission. */
  const lastSseEventAtRef = useRef<number>(0);
  const viewingMissionIdRef = useRef<string | null>(null);
  const runStateMissionIdRef = useRef<string | null>(null);
  const runningMissionsRef = useRef<RunningMissionInfo[]>([]);
  const currentMissionRef = useRef<Mission | null>(null);
  const viewingMissionRef = useRef<Mission | null>(null);
  const submittingRef = useRef(false); // Guard against double-submission
  const autoTitleAttemptedRef = useRef<Set<string>>(new Set()); // Track missions we've tried to auto-title
  const inputRef = useRef(input);
  const draftMissionIdRef = useRef<string | null>(viewingMissionId);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    const previousMissionId = draftMissionIdRef.current;
    if (previousMissionId === viewingMissionId) return;

    saveControlDraftForMission(inputRef.current, previousMissionId);
    const nextDraft = loadControlDraftForMission(viewingMissionId);
    draftMissionIdRef.current = viewingMissionId;
    inputRef.current = nextDraft;
    setInput(nextDraft);
  }, [viewingMissionId]);

  // Keep refs in sync with state
  useEffect(() => {
    viewingMissionIdRef.current = viewingMissionId;
    // Reconnect the SSE stream so the server-side ?mission=<uuid> filter
    // (P1-#4) re-binds to the freshly-viewed mission. Skipped on the very
    // first render — the stream effect makes the initial connection itself.
    if (reconnectStreamRef.current) {
      reconnectStreamRef.current();
    }
    // P1-#9 navigation leak guard. Every entry path eventually changes
    // `viewingMissionId` — handleViewMission, the URL-driven effect, the
    // mission switcher palette. Centralizing the cleanup here means a
    // future path can't forget to clear refs. Bubble-buffer refs hold the
    // *previous* mission's tail of streaming deltas; if we don't drop them
    // here they get appended to the new mission's first bubble on the
    // next flush, and the abandoned setTimeout keeps the previous closure
    // alive (the main contributor to the ~150 MB-per-visit heap ratchet
    // we measured).
    if (thinkingFlushTimeoutRef.current) {
      clearTimeout(thinkingFlushTimeoutRef.current);
      thinkingFlushTimeoutRef.current = null;
    }
    if (thinkingFlushRafRef.current !== null) {
      cancelAnimationFrame(thinkingFlushRafRef.current);
      thinkingFlushRafRef.current = null;
    }
    if (streamFlushTimeoutRef.current) {
      clearTimeout(streamFlushTimeoutRef.current);
      streamFlushTimeoutRef.current = null;
    }
    if (streamFlushRafRef.current !== null) {
      cancelAnimationFrame(streamFlushRafRef.current);
      streamFlushRafRef.current = null;
    }
    pendingThinkingRef.current = null;
    pendingStreamRef.current = null;
  }, [viewingMissionId]);

  useEffect(() => {
    runStateMissionIdRef.current = runStateMissionId;
  }, [runStateMissionId]);

  useEffect(() => {
    runningMissionsRef.current = runningMissions;
  }, [runningMissions]);

  useEffect(() => {
    currentMissionRef.current = currentMission;
  }, [currentMission]);

  useEffect(() => {
    viewingMissionRef.current = viewingMission;
  }, [viewingMission]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Backwards-pagination scroll restore. `loadOlderHistoryEvents` snapshots
  // `scrollTop` + `scrollHeight` BEFORE prepending items into this ref;
  // after React commits the longer list, we adjust `scrollTop` to keep the
  // previously-visible message in the viewport. This MUST run in a
  // `useLayoutEffect` (synchronously after commit, before browser paint) —
  // doing it in `requestAnimationFrame` produces a one-frame flash where
  // the user sees the old `scrollTop` against the new (taller) DOM before
  // the adjustment lands. Declared after the scroll-to-bottom effect on
  // purpose so React runs it second; the bottom-scroll only fires when
  // `isAtBottom`, which is never true during a paginate-back.
  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (!pending) return;
    pendingScrollRestoreRef.current = null;
    const scrollEl = containerRef.current;
    if (!scrollEl) return;
    const newScrollHeight = scrollEl.scrollHeight;
    scrollEl.scrollTop =
      newScrollHeight - pending.oldScrollHeight + pending.oldScrollTop;
  }, [items]);

  // Sync input to the mission-scoped localStorage draft cache.
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      saveControlDraftForMission(input, draftMissionIdRef.current);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [input]);

  const compressImageFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return file;
    if (file.type === "image/gif" || file.type === "image/svg+xml") return file;

    const maxDimension = 1280;
    const minBytesForCompression = 300 * 1024;

    if (file.size < minBytesForCompression) {
      return file;
    }

    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return file;
    }

    const maxSide = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxDimension / maxSide);
    if (scale === 1 && file.size < minBytesForCompression) {
      bitmap.close();
      return file;
    }

    const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }

    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.8),
    );
    if (!blob) return file;

    if (blob.size >= file.size && scale === 1) return file;

    const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
    const compressedName = `${baseName}-compressed.jpg`;
    return new globalThis.File([blob], compressedName, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  }, []);

  // Handle file upload - wrapped in useCallback to avoid stale closures
  const handleFileUpload = useCallback(
    async (file: File, insertion?: InputInsertionState) => {
      let fileToUpload = file;
      try {
        fileToUpload = await compressImageFile(file);
      } catch (error) {
        console.warn("Image compression failed, using original file", error);
      }

      const displayName = fileToUpload.name;
      setUploadQueue((prev) => [...prev, displayName]);
      setUploadProgress({
        fileName: displayName,
        progress: { loaded: 0, total: fileToUpload.size, percentage: 0 },
      });

      try {
        // Upload to mission-specific context folder if we have a mission
        // Upload into the workspace-local ./context (symlinked to mission context inside the container).
        const contextPath = "./context/";

        // Get workspace_id and mission_id from current or viewing mission
        const mission = viewingMission ?? currentMission;
        const workspaceId = mission?.workspace_id;
        const missionId = mission?.id;

        // Use chunked upload for files > 10MB, regular for smaller
        const useChunked = fileToUpload.size > 10 * 1024 * 1024;

        const result = useChunked
          ? await uploadFileChunked(
              fileToUpload,
              contextPath,
              (progress) => {
                setUploadProgress({ fileName: displayName, progress });
              },
              workspaceId,
              missionId,
            )
          : await uploadFile(
              fileToUpload,
              contextPath,
              (progress) => {
                setUploadProgress({ fileName: displayName, progress });
              },
              workspaceId,
              missionId,
            );

        toast.success(`Uploaded ${result.name}`);

        const uploadNote = `[Uploaded: ${result.path}]`;
        if (insertion) {
          setInput((prev) => {
            const textToInsert =
              insertion.insertedCount > 0 ? `\n${uploadNote}` : uploadNote;
            const inserted = insertTextAtSelection(prev, textToInsert, {
              start: insertion.start,
              end: insertion.end,
            });
            insertion.start = inserted.cursor;
            insertion.end = inserted.cursor;
            insertion.insertedCount += 1;
            return inserted.value;
          });
        } else {
          // Preserve existing non-paste behavior for attach/upload button paths.
          setInput((prev) => {
            return prev ? `${uploadNote}\n${prev}` : uploadNote;
          });
        }
      } catch (error) {
        console.error("Upload failed:", error);
        const detail =
          error instanceof Error
            ? error.message.replace(/^Upload failed:\s*/, "").trim()
            : "";
        const suffix = detail
          ? `: ${detail.slice(0, 180)}${detail.length > 180 ? "..." : ""}`
          : "";
        toast.error(`Failed to upload ${displayName}${suffix}`);
      } finally {
        setUploadQueue((prev) => prev.filter((name) => name !== displayName));
        setUploadProgress(null);
      }
    },
    [compressImageFile, currentMission, viewingMission],
  );

  // Handle file input change
  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files || []);
    for (const file of files) {
      await handleFileUpload(file);
    }
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // Handle paste to upload files (e.g., screenshots from clipboard)
  const handleFilePaste = useCallback(
    async (files: File[], context: FilePasteContext) => {
      const insertion: InputInsertionState = {
        start: context.selectionStart,
        end: context.selectionEnd,
        insertedCount: 0,
      };
      for (const file of files) {
        await handleFileUpload(file, insertion);
      }
    },
    [handleFileUpload],
  );

  // Convert mission history to chat items
  const getActiveDesktopSession = useCallback((mission?: Mission | null) => {
    if (!mission || !Array.isArray(mission.desktop_sessions)) {
      return null;
    }
    for (let i = mission.desktop_sessions.length - 1; i >= 0; i -= 1) {
      const session = mission.desktop_sessions[i];
      if (!session?.stopped_at) {
        return session;
      }
    }
    return null;
  }, []);

  const extractDesktopDisplay = useCallback((value: unknown): string | null => {
    function parseDisplayFromString(text: string): string | null {
      try {
        const parsed = JSON.parse(text);
        const nested = extractFromValue(parsed);
        if (nested) return nested;
      } catch {
        // Ignore parse errors - fall back to regex
      }
      const match = text.match(/"display"\s*:\s*"([^"]+)"/i);
      return match ? match[1] : null;
    }

    function extractFromValue(node: unknown): string | null {
      if (!node) return null;
      if (typeof node === "string") {
        return parseDisplayFromString(node);
      }
      if (Array.isArray(node)) {
        for (const item of node) {
          const found = extractFromValue(item);
          if (found) return found;
        }
        return null;
      }
      if (typeof node === "object") {
        const record = node as Record<string, unknown>;
        if (typeof record.display === "string") {
          return record.display;
        }
        if (record.result) {
          const fromResult = extractFromValue(record.result);
          if (fromResult) return fromResult;
        }
        if (record.content) {
          const fromContent = extractFromValue(record.content);
          if (fromContent) return fromContent;
        }
        if (record.structured_content) {
          const fromStructured = extractFromValue(record.structured_content);
          if (fromStructured) return fromStructured;
        }
        if (typeof record.text === "string") {
          const fromText = parseDisplayFromString(record.text);
          if (fromText) return fromText;
        }
      }
      return null;
    }

    return extractFromValue(value);
  }, []);

  // Helper to check if mission history has an active desktop session
  // A session is active if there's a start without a subsequent close
  const missionHasDesktopSession = useCallback(
    (mission: Mission): boolean => {
      if (getActiveDesktopSession(mission)) {
        return true;
      }
      let hasSession = false;
      const history = Array.isArray(mission.history) ? mission.history : [];
      for (const entry of history) {
        // Check for session start
        if (
          entry.content.includes("desktop_start_session") ||
          entry.content.includes("desktop_desktop_start_session") ||
          entry.content.includes("mcp__desktop__desktop_start_session")
        ) {
          hasSession = true;
        }
        // Check for session close (must come after start check to handle same entry)
        if (
          entry.content.includes("desktop_close_session") ||
          entry.content.includes("desktop_desktop_close_session") ||
          entry.content.includes("mcp__desktop__desktop_close_session")
        ) {
          hasSession = false;
        }
      }
      return hasSession;
    },
    [getActiveDesktopSession],
  );

  const applyDesktopSessionState = useCallback(
    (mission: Mission) => {
      const activeSession = getActiveDesktopSession(mission);
      if (activeSession?.display) {
        // Only switch display if the current one is not running for THIS mission.
        // This prevents auto-switching away from a display the user is actively viewing,
        // but allows switching when changing to a different mission.
        const currentDisplayId = desktopDisplayIdRef.current;
        const currentBelongsToThisMission = mission.desktop_sessions?.some(
          (s) => s.display === currentDisplayId && !s.stopped_at,
        );
        if (!currentBelongsToThisMission) {
          setDesktopDisplayId(activeSession.display);
        }
        setHasDesktopSession(true);
        // Auto-open desktop panel when mission has an active session
        setShowDesktopStream(true);
        return;
      }
      if (missionHasDesktopSession(mission)) {
        setHasDesktopSession(true);
        setShowDesktopStream(true);
      } else {
        setHasDesktopSession(false);
      }
    },
    [getActiveDesktopSession, missionHasDesktopSession],
  );

  // Detect desktop sessions from stored events (when loading from history)
  // This handles the case where mission.desktop_sessions isn't populated yet
  // and mission.history doesn't include tool calls (SQLite only stores user/assistant messages)
  const applyDesktopSessionFromEvents = useCallback(
    (events: StoredEvent[] | null) => {
      if (!events) return;

      // Track sessions by display: true = started, false = closed
      const sessionsByDisplay = new Map<string, boolean>();
      let latestActiveDisplay: string | null = null;

      for (const event of events) {
        if (event.event_type !== "tool_result") continue;

        const toolName = event.tool_name;
        const isStart =
          toolName === "desktop_start_session" ||
          toolName === "desktop_desktop_start_session" ||
          toolName === "mcp__desktop__desktop_start_session";
        const isClose =
          toolName === "desktop_close_session" ||
          toolName === "desktop_desktop_close_session" ||
          toolName === "mcp__desktop__desktop_close_session";

        if (!isStart && !isClose) continue;

        // Parse result to get display
        const display = extractDesktopDisplay(event.content);
        if (!display) continue;

        if (isStart) {
          sessionsByDisplay.set(display, true);
          latestActiveDisplay = display;
        } else if (isClose) {
          sessionsByDisplay.set(display, false);
          if (latestActiveDisplay === display) {
            latestActiveDisplay = null;
          }
        }
      }

      // Check if we found any active sessions
      if (latestActiveDisplay) {
        setDesktopDisplayId(latestActiveDisplay);
        setHasDesktopSession(true);
        setShowDesktopStream(true);
      } else {
        // Check if any session is still active
        for (const [display, isActive] of sessionsByDisplay) {
          if (isActive) {
            setDesktopDisplayId(display);
            setHasDesktopSession(true);
            setShowDesktopStream(true);
            return;
          }
        }
      }
    },
    [extractDesktopDisplay],
  );

  const hasRunningDesktopSessionForMission = useCallback(
    (missionId: string | null): boolean => {
      if (!missionId) return false;
      const activeMission =
        viewingMissionRef.current ?? currentMissionRef.current;
      if (activeMission?.id === missionId) {
        if (getActiveDesktopSession(activeMission)) {
          return true;
        }
      }
      return desktopSessionsRef.current.some(
        (session) =>
          session.process_running &&
          session.status !== "stopped" &&
          session.mission_id === missionId,
      );
    },
    [getActiveDesktopSession],
  );

  const missionForDownloads = viewingMission ?? currentMission;

  // Derive working directory for file-path resolution in rich `<image>`/
  // `<file>` tags. Priority:
  //   1. `mission.working_directory` — what the agent actually `cd`'d into
  //      (e.g. `/workspaces/mission-XXX/keel`). Without this, relative paths
  //      like `./docs/foo.png` resolve to the mission root and miss files
  //      that live in a cloned-repo subdir.
  //   2. Latest desktop session's `screenshots_dir` parent.
  //   3. `{workspace.path}/workspaces/mission-{shortId}` — but only when the
  //      mission's `workspace_id` still resolves. The previous host-workspace
  //      fallback produced a misleading basePath (e.g. `/root/workspaces/…`)
  //      that 404'd every request without explaining why. Returning
  //      `undefined` instead lets `InlineImagePreview`/`InlineFileCard`
  //      surface a clear "workspace unavailable" pill.
  const missionWorkingDirectory = useMemo(() => {
    const mission = missionForDownloads;
    if (!mission) return undefined;

    if (mission.working_directory?.trim()) {
      return mission.working_directory.replace(/\/+$/, "");
    }

    if (mission.desktop_sessions?.length) {
      for (let i = mission.desktop_sessions.length - 1; i >= 0; i--) {
        const session = mission.desktop_sessions[i];
        if (session?.screenshots_dir) {
          const dir = session.screenshots_dir.replace(/\/?$/, "");
          const parent = dir.substring(0, dir.lastIndexOf("/"));
          if (parent) return parent;
        }
      }
    }

    if (!mission.workspace_id) return undefined;
    const workspace = workspaces.find((ws) => ws.id === mission.workspace_id);
    if (!workspace?.path) return undefined;

    const cleanRoot = workspace.path.replace(/\/+$/, "");
    const shortId = mission.id?.slice(0, 8);
    if (shortId) {
      return `${cleanRoot}/workspaces/mission-${shortId}`;
    }
    return cleanRoot;
  }, [missionForDownloads, workspaces]);

  const missionHistoryToItems = useCallback((mission: Mission): ChatItem[] => {
    // Estimate timestamps based on mission creation time
    const baseTime = new Date(mission.created_at).getTime();
    const history = Array.isArray(mission.history) ? mission.history : [];
    // Find index of last assistant message to apply mission status
    const lastAssistantIdx = history.reduce(
      (lastIdx, entry, i) => (entry.role === "assistant" ? i : lastIdx),
      -1,
    );
    // Mission is considered failed if status is "failed"
    const missionFailed = mission.status === "failed";

    return history.map((entry, i) => {
      // Spread timestamps across history (rough estimate)
      const timestamp = baseTime + i * 60000; // 1 minute apart
      if (entry.role === "user") {
        return {
          kind: "user" as const,
          id: `history-${mission.id}-${i}`,
          content: entry.content,
          timestamp,
        };
      } else {
        // Last assistant message inherits mission status
        // Earlier assistant messages are assumed successful
        const isLastAssistant = i === lastAssistantIdx;
        const success = isLastAssistant ? !missionFailed : true;
        return {
          kind: "assistant" as const,
          id: `history-${mission.id}-${i}`,
          content: entry.content,
          success,
          costCents: 0,
          costSource: "unknown" as const,
          model: null,
          timestamp,
          resumable:
            isLastAssistant && missionFailed ? mission.resumable : undefined,
        };
      }
    });
  }, []);

  const mergeEventItemsWithMissionHistoryFallback = useCallback(
    (eventItems: ChatItem[], mission: Mission): ChatItem[] => {
      if (eventItems.some((item) => item.kind === "assistant")) {
        return eventItems;
      }

      const history = Array.isArray(mission.history) ? mission.history : [];
      const historyHasAssistant = history.some(
        (entry) => entry.role === "assistant",
      );
      if (!historyHasAssistant) {
        return eventItems;
      }

      const basicItems = missionHistoryToItems(mission);
      if (eventItems.length === 0) {
        return basicItems;
      }

      // Long Codex `/goal` missions can spend thousands of events in
      // tool/thinking/status loops without a fresh assistant_message.
      // The latest event page is still valuable: it contains the
      // completed thought history and tool rows. Keep that replay and
      // prepend coarse mission history so the chat still has prior
      // user/assistant context.
      const basicIds = new Set(basicItems.map((item) => item.id));
      const eventOnlyItems = eventItems.filter(
        (item) => !basicIds.has(item.id),
      );
      return [...basicItems, ...eventOnlyItems];
    },
    [missionHistoryToItems],
  );

  // Convert stored events (from SQLite) to ChatItems for display
  // This enables full history replay including tool calls on page refresh
  const eventsToItems = useCallback(
    (events: StoredEvent[], mission?: Mission | null): ChatItem[] => {
      return perfBus.time("replay:apply", () =>
        eventsToItemsImpl(events, mission),
      );
    },
    [],
  );
  const eventsWorkerRef = useRef<Worker | null | false>(null);
  const eventsWorkerSeqRef = useRef(0);
  const eventsWorkerPendingRef = useRef(
    new Map<
      number,
      {
        resolve: (items: ChatItem[]) => void;
        reject: (error: Error) => void;
      }
    >(),
  );

  useEffect(() => {
    const pendingMap = eventsWorkerPendingRef.current;
    return () => {
      if (eventsWorkerRef.current instanceof Worker) {
        eventsWorkerRef.current.terminate();
      }
      for (const pending of pendingMap.values()) {
        pending.reject(new Error("events worker terminated"));
      }
      pendingMap.clear();
    };
  }, []);

  const getEventsWorker = useCallback((): Worker | null => {
    if (eventsWorkerRef.current === false) return null;
    if (eventsWorkerRef.current) return eventsWorkerRef.current;

    try {
      const worker = new Worker(new URL("./events-worker.ts", import.meta.url));
      worker.onmessage = (message: MessageEvent<EventsWorkerResponse>) => {
        const response = message.data;
        const pending = eventsWorkerPendingRef.current.get(response.id);
        if (!pending) return;
        eventsWorkerPendingRef.current.delete(response.id);
        if (response.ok) {
          pending.resolve(response.items);
        } else {
          pending.reject(new Error(response.error));
        }
      };
      worker.onerror = (event) => {
        for (const pending of eventsWorkerPendingRef.current.values()) {
          pending.reject(
            new Error(event.message || "events worker failed to load"),
          );
        }
        eventsWorkerPendingRef.current.clear();
        worker.terminate();
        eventsWorkerRef.current = false;
      };
      eventsWorkerRef.current = worker;
      return worker;
    } catch {
      eventsWorkerRef.current = false;
      return null;
    }
  }, []);

  const eventsToItemsAsync = useCallback(
    async (
      events: StoredEvent[],
      mission?: Mission | null,
    ): Promise<ChatItem[]> => {
      if (events.length < 500) {
        return eventsToItems(events, mission);
      }

      const worker = getEventsWorker();
      if (!worker) {
        return eventsToItems(events, mission);
      }

      const id = eventsWorkerSeqRef.current++;
      try {
        return await perfBus.time(
          "replay:apply:worker",
          () =>
            new Promise<ChatItem[]>((resolve, reject) => {
              eventsWorkerPendingRef.current.set(id, { resolve, reject });
              worker.postMessage({
                id,
                events,
                mission,
              } satisfies EventsWorkerRequest);
            }),
        );
      } catch (error) {
        eventsWorkerPendingRef.current.delete(id);
        eventsWorkerRef.current = false;
        worker.terminate();
        console.warn(
          "[control] events worker failed; falling back to sync",
          error,
        );
        return eventsToItems(events, mission);
      }
    },
    [eventsToItems, getEventsWorker],
  );

  /**
   * Fetch the next page of older history events (events with `sequence`
   * strictly less than the lowest currently loaded). Replays
   * `eventsToItems` over the full accumulated event set so tool-call /
   * tool-result linkage and thinking-delta consolidation stay coherent
   * across the page boundary, then splices the new historic prefix in
   * front of the SSE-appended live tail.
   *
   * Defined after `eventsToItems` so the callback's dependency array can
   * reference it without hitting `const` TDZ at component init.
   */
  const loadOlderHistoryEvents = useCallback(
    async (id: string, opts?: { silent?: boolean; limit?: number }) => {
      const beforeSeq = missionMinSeqRef.current.get(id);
      if (beforeSeq === undefined || beforeSeq <= 1) {
        setOlderLoadState({ missionId: id, hasMore: false, loading: false });
        return;
      }
      // Race guard. If another path (manual click vs background fill)
      // is already paginating older for this mission, drop this call
      // rather than fetch the same page and prepend duplicate events.
      if (paginatingOlderRef.current.has(id)) {
        return;
      }
      paginatingOlderRef.current.add(id);
      // The button click that fired this is for the currently-viewing
      // mission, so writing `missionId: id` here is correct. If the user
      // switches missions during the in-flight fetch, the UI's
      // `activeOlderLoadState` selector will discard this loading state
      // (it filters on `missionId === viewingMissionId`), so a fetch
      // that never gets to clear `loading: false` can't pin the new
      // mission's button to a stuck "Loading…" state.
      //
      // `silent: true` (used by the background fill after initial load)
      // skips toggling `olderLoadState.loading` so the "Load older
      // messages…" button doesn't flicker into a loading state while the
      // user is just reading the latest messages.
      if (!opts?.silent) {
        setOlderLoadState((prev) => ({
          missionId: id,
          hasMore: prev.missionId === id ? prev.hasMore : false,
          loading: true,
        }));
      }
      try {
        try {
          const { events: olderEvents } = await getMissionEventsWithMeta(id, {
            types: HISTORY_EVENT_TYPES,
            beforeSeq,
            limit: opts?.limit ?? HISTORY_PAGE_SIZE,
          });
          if (olderEvents.length === 0) {
            // Same per-mission gate as below — see comment on
            // `stillActiveForId`. If the user switched missions while we
            // were fetching, don't pin the new mission's UI to "no more
            // older messages" based on the old mission's empty page.
            if (
              currentMissionRef.current?.id === id ||
              viewingMissionRef.current?.id === id
            ) {
              setOlderLoadState({
                missionId: id,
                hasMore: false,
                loading: false,
              });
            }
            return;
          }

          // After the await, the user may have switched missions. Read the
          // *currently-viewing* mission from refs (which the keep-in-sync
          // useEffects update synchronously from state), NOT from the
          // closure-captured `viewingMission` — that's stale across renders
          // and would happily prepend the old mission's events into the new
          // mission's items.
          const liveCurrent = currentMissionRef.current;
          const liveViewing = viewingMissionRef.current;
          // Single shared gate. If false, this completion belongs to a
          // mission the user has already navigated away from — every side
          // effect below (cursor advance, cache merge, items splice,
          // `olderLoadState` reset, scroll restore) MUST be skipped, or a
          // stale-mission completion will corrupt refs that
          // `loadHistoryEvents`/`reloadMissionHistory` may not reset on the
          // user's eventual return path.
          const stillActiveForId =
            liveCurrent?.id === id || liveViewing?.id === id;

          if (stillActiveForId) {
            const sortedOlder = olderEvents
              .slice()
              .sort((a, b) => a.sequence - b.sequence);

            missionMinSeqRef.current.set(id, sortedOlder[0].sequence);
            const existing = missionHistoricEventsRef.current.get(id) ?? [];
            const merged = [...sortedOlder, ...existing];
            missionHistoricEventsRef.current.set(id, merged);

            const mission =
              liveCurrent?.id === id
                ? liveCurrent
                : liveViewing?.id === id
                  ? liveViewing
                  : null;
            const newHistoricItems = eventsToItems(merged, mission);
            const oldHistoricCount = historicItemsCountRef.current.get(id) ?? 0;
            historicItemsCountRef.current.set(id, newHistoricItems.length);

            // Snapshot scroll geometry FIRST, then setItems. The
            // `useLayoutEffect` watching `items` reads
            // `pendingScrollRestoreRef` synchronously after commit and
            // BEFORE paint, so the user never sees the longer DOM with
            // the old scrollTop. (Doing this in `requestAnimationFrame`
            // would land one frame late and produce a visible jump.)
            const scrollEl = containerRef.current;
            if (scrollEl) {
              pendingScrollRestoreRef.current = {
                oldScrollTop: scrollEl.scrollTop,
                oldScrollHeight: scrollEl.scrollHeight,
              };
            }

            setItems((prev) => {
              const liveTail = prev.slice(oldHistoricCount);
              return [...newHistoricItems, ...liveTail];
            });

            // The render path uses `groupedItems.slice(-visibleItemsLimit)` —
            // the LAST N items. Prepended older items land at the START of
            // the array, so without expanding the limit they'd never
            // actually render and the chat would visually be unchanged
            // (and the scroll-restore would no-op against an unchanged
            // DOM). Grow the limit by exactly the number of newly-added
            // historic items so the visible window now also covers the
            // older page. We don't shrink it past `prev` — other code
            // may have already grown it for unrelated reasons.
            //
            // In `silent` mode (post-initial background fill) we deliberately
            // skip this — the user is reading the latest messages and the
            // older content stays in the accumulated cache. When they scroll
            // up the existing "load more visible items" handler grows the
            // window, surfacing the already-fetched events without a network
            // round-trip.
            if (!opts?.silent) {
              const addedHistoricItems =
                newHistoricItems.length - oldHistoricCount;
              if (addedHistoricItems > 0) {
                setVisibleItemsLimit((prev) => prev + addedHistoricItems);
              }
            }

            setOlderLoadState({
              missionId: id,
              hasMore: computeHasMoreOlder(id),
              loading: false,
            });
          }
        } catch (err) {
          console.error("Failed to load older events:", err);
          // Background fill is invisible work — a fetch failure mid-stream
          // shouldn't pop a toast. The user-driven "Load older messages"
          // button does want one. `streamOlderHistory` rethrows nothing,
          // it just stops walking on error, which is the right behavior
          // (the user can still hit the manual button later).
          if (!opts?.silent) {
            toast.error("Failed to load older messages");
          }
          // Only clear the loading flag if the active mission is still the
          // one we were paginating — otherwise we'd wipe state set for a
          // newer, unrelated mission. (The missionId-tagged read selector
          // also protects the UI here, but we keep this guard so we don't
          // gratuitously rewrite state for a mission that isn't viewable.)
          const stillActive =
            currentMissionRef.current?.id === id ||
            viewingMissionRef.current?.id === id;
          if (stillActive && !opts?.silent) {
            setOlderLoadState((prev) =>
              prev.missionId === id ? { ...prev, loading: false } : prev,
            );
          }
          if (opts?.silent) {
            // Propagate so `streamOlderHistory` can stop the fill loop on
            // failure instead of wedging in a tight retry.
            throw err;
          }
        }
      } finally {
        paginatingOlderRef.current.delete(id);
      }
    },
    // Note: `viewingMission` is intentionally NOT in deps — the body now
    // reads `viewingMissionRef.current` (synced from state by an effect
    // above), so capturing the state value would re-introduce the stale
    // closure that bugbot flagged.
    [HISTORY_EVENT_TYPES, eventsToItems, computeHasMoreOlder, setItems],
  );

  // Background fill: after the initial fetch shows the newest events,
  // walk older pages until we've reached `BACKGROUND_FILL_TARGET` total
  // history events or there are no more. Runs `silent` so the
  // "Load older messages" button doesn't flash a loading state; bails
  // if the user switches missions, if a fetch fails, or if the mission
  // turns out to have fewer events than the target (server total reached).
  const streamOlderHistory = useCallback(
    async (id: string) => {
      // Yield once so the initial-render setItems can commit and paint
      // before we start eating network/main-thread time on background
      // fills. Without this the first chunk can land before the user
      // sees the latest message at all.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stillActive = (): boolean =>
        currentMissionRef.current?.id === id ||
        viewingMissionRef.current?.id === id;

      // Up to a few page-loads, with a small inter-page yield so live
      // SSE events can interleave on the main thread without jank.
      // Hard ceiling (16) is a backstop; the loop normally exits via
      // the `hasMore`/target check first.
      for (let i = 0; i < 16; i++) {
        if (!stillActive()) return;
        const accumulated =
          missionHistoricEventsRef.current.get(id)?.length ?? 0;
        const total = missionTotalHistoryRef.current.get(id);
        if (total !== undefined && accumulated >= total) return;
        if (accumulated >= BACKGROUND_FILL_TARGET) return;
        const minSeq = missionMinSeqRef.current.get(id);
        if (minSeq === undefined || minSeq <= 1) return;

        try {
          await loadOlderHistoryEvents(id, {
            silent: true,
            limit: BACKGROUND_FILL_PAGE_SIZE,
          });
        } catch {
          // Stop on error — the user's manual "Load older messages"
          // path remains available for retry.
          return;
        }

        // If accumulated didn't grow, the server returned an empty
        // page and there's nothing left to fetch. Avoid the
        // pathological tight loop.
        const after = missionHistoricEventsRef.current.get(id)?.length ?? 0;
        if (after <= accumulated) return;

        // Small pause between pages so the main thread can run other
        // work (live event handlers, scroll, input).
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    },
    [loadOlderHistoryEvents, BACKGROUND_FILL_PAGE_SIZE, BACKGROUND_FILL_TARGET],
  );

  // Wire the ref consumed by `loadHistoryEvents` (which is declared
  // above `streamOlderHistory`, so it can't reference it directly).
  useEffect(() => {
    streamOlderHistoryRef.current = streamOlderHistory;
    return () => {
      streamOlderHistoryRef.current = null;
    };
  }, [streamOlderHistory]);

  // Load mission from URL param on mount (and retry on auth success)
  const [authRetryTrigger, setAuthRetryTrigger] = useState(0);

  // Listen for auth success to retry loading
  useEffect(() => {
    const onAuthSuccess = () => {
      setAuthRetryTrigger((prev) => prev + 1);
    };
    window.addEventListener("openagent:auth:success", onAuthSuccess);
    return () =>
      window.removeEventListener("openagent:auth:success", onAuthSuccess);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const missionId = searchParams.get("mission");

    const loadFromQuery = async (id: string) => {
      const pendingId = pendingMissionNavRef.current;
      if (pendingId && id !== pendingId) {
        // Ignore stale query params while we navigate to a newly-created mission.
        return;
      }
      if (pendingId && id === pendingId) {
        pendingMissionNavRef.current = null;
      }
      // Skip loading if we already have this mission in state (e.g., after handleNewMission)
      if (viewingMissionRef.current?.id === id) {
        setViewingMissionId(id);
        return;
      }
      // Skip if handleViewMission is already loading this mission (prevents double-load race)
      if (handleViewMissionLoadingRef.current === id) {
        return;
      }
      const previousViewingMission = viewingMissionRef.current;
      setMissionLoading(true);
      setViewingMissionId(id); // Set viewing ID immediately to prevent "Agent is working..." flash
      fetchingMissionIdRef.current = id; // Track which mission we're loading
      try {
        // Load mission, events, and queue in parallel for faster load
        const [mission, events, queuedMessages] = await Promise.all([
          loadMission(id),
          loadHistoryEvents(id).catch(() => null), // Don't fail if events unavailable
          getQueue().catch(() => []), // Don't fail if queue unavailable
        ]);
        if (cancelled || fetchingMissionIdRef.current !== id) return;
        // Mission not found (404) - clear state and URL param without showing error
        if (!mission) {
          setViewingMissionId(null);
          setViewingMission(null);
          setCurrentMission(null);
          setItems([]);
          setVisibleItemsLimit(INITIAL_VISIBLE_ITEMS);
          setHasDesktopSession(false);
          setLastMissionId(null); // Clear stale last mission ID from localStorage
          router.replace("/control", { scroll: false });
          return;
        }
        setCurrentMission(mission);
        setViewingMission(mission);
        // Hydrate the goal-mode pill state from persisted events so the
        // "Goal · iter N · …" badge survives a page reload. Without this,
        // goalInfoByMission only updates from live SSE — a goal mission
        // already in flight when the user opens the page renders with no
        // pill until the next goal_iteration arrives. Walk events newest
        // first; first matching goal_iteration / goal_status wins.
        if (events) {
          let latestIteration: number | undefined;
          let latestStatus: string | undefined;
          let latestObjective: string | undefined;
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i];
            const meta = (ev as { metadata?: unknown }).metadata;
            const metaRecord = isRecord(meta) ? meta : null;
            if (
              latestIteration === undefined &&
              ev.event_type === "goal_iteration"
            ) {
              if (metaRecord && typeof metaRecord["iteration"] === "number") {
                latestIteration = metaRecord["iteration"] as number;
              }
              if (typeof ev.content === "string") {
                latestObjective = ev.content;
              }
            }
            if (latestStatus === undefined && ev.event_type === "goal_status") {
              if (metaRecord && typeof metaRecord["status"] === "string") {
                latestStatus = metaRecord["status"] as string;
              }
              if (typeof ev.content === "string" && !latestObjective) {
                latestObjective = ev.content;
              }
            }
            if (latestIteration !== undefined && latestStatus !== undefined)
              break;
          }
          // Skip terminal statuses — those clear the pill, matching the live handler.
          const isTerminalStatus = latestStatus
            ? ["complete", "cleared", "budgetLimited", "aborted"].includes(
                latestStatus,
              )
            : false;
          if (
            (latestIteration !== undefined || latestStatus !== undefined) &&
            !isTerminalStatus
          ) {
            setGoalInfoByMission((prev) => ({
              ...prev,
              [id]: {
                iteration: latestIteration ?? prev[id]?.iteration ?? 0,
                status: latestStatus ?? prev[id]?.status ?? "active",
                objective: latestObjective ?? prev[id]?.objective ?? "",
              },
            }));
          }
        }
        // Use events if available, otherwise fall back to basic history
        let historyItems = events
          ? mergeEventItemsWithMissionHistoryFallback(
              await eventsToItemsAsync(events, mission),
              mission,
            )
          : missionHistoryToItems(mission);
        // Capture the events-derived count BEFORE the queue merge — this is
        // what `loadOlderHistoryEvents` needs to find the live tail
        // correctly (see `seedPaginationStateAfterInitialLoad`).
        const historicEventsLen = historyItems.length;
        // Merge queued messages that belong to this mission
        const missionQueuedMessages = queuedMessages.filter(
          (qm) => qm.mission_id === id,
        );
        if (missionQueuedMessages.length > 0) {
          const queuedIds = new Set(missionQueuedMessages.map((qm) => qm.id));
          // Mark existing items as queued
          historyItems = historyItems.map((item) =>
            item.kind === "user" && queuedIds.has(item.id)
              ? { ...item, queued: true }
              : item,
          );
          // Add any queued messages not already in history
          const existingIds = new Set(historyItems.map((item) => item.id));
          const newQueuedItems: ChatItem[] = missionQueuedMessages
            .filter((qm) => !existingIds.has(qm.id))
            .map((qm) => ({
              kind: "user" as const,
              id: qm.id,
              content: qm.content,
              timestamp: Date.now(),
              agent: qm.agent ?? undefined,
              queued: true,
            }));
          historyItems = [...historyItems, ...newQueuedItems];
        }
        setItems(historyItems);
        adjustVisibleItemsLimit(historyItems);
        seedPaginationStateAfterInitialLoad(id, historicEventsLen);
        applyDesktopSessionState(mission);
        // Also check events for desktop sessions (in case mission.desktop_sessions isn't populated yet)
        if (events) {
          applyDesktopSessionFromEvents(events);
        }
      } catch (err) {
        if (cancelled || fetchingMissionIdRef.current !== id) return;
        console.error("Failed to load mission:", err);
        // Show error toast for mission load failures (skip if likely a 401 during initial page load)
        const is401 =
          (err as Error)?.message?.includes("401") ||
          (err as { status?: number })?.status === 401;
        if (!is401) {
          toast.error("Failed to load mission");
        }

        // Revert viewing state to the previous mission to avoid filtering out events
        const fallbackMission =
          previousViewingMission ?? currentMissionRef.current;
        if (fallbackMission) {
          setViewingMissionId(fallbackMission.id);
          setViewingMission(fallbackMission);
          setItems(missionHistoryToItems(fallbackMission));
          setVisibleItemsLimit(INITIAL_VISIBLE_ITEMS);
          applyDesktopSessionState(fallbackMission);
        } else {
          setViewingMissionId(null);
          setViewingMission(null);
          setItems([]);
          setVisibleItemsLimit(INITIAL_VISIBLE_ITEMS);
          setHasDesktopSession(false);
        }
      } finally {
        if (!cancelled) setMissionLoading(false);
      }
    };

    const loadFromCurrent = async () => {
      try {
        const mission = await getCurrentMission();
        if (cancelled) return;
        if (mission) {
          setCurrentMission(mission);
          setViewingMission(mission);
          // Show basic history immediately, then load full events
          {
            const basicItems = missionHistoryToItems(mission);
            setItems(basicItems);
            adjustVisibleItemsLimit(basicItems);
          }
          applyDesktopSessionState(mission);
          router.replace(`/control?mission=${mission.id}`, { scroll: false });
          // Load full events and queue in background (including tool calls)
          Promise.all([
            loadHistoryEvents(mission.id),
            getQueue().catch(() => []),
          ])
            .then(async ([events, queuedMessages]) => {
              if (cancelled) return;
              let historyItems = mergeEventItemsWithMissionHistoryFallback(
                await eventsToItemsAsync(events, mission),
                mission,
              );
              // Capture pre-queue length so pagination doesn't clip
              // queued items (see `seedPaginationStateAfterInitialLoad`).
              const historicEventsLen = historyItems.length;
              // Merge queued messages that belong to this mission
              const missionQueuedMessages = queuedMessages.filter(
                (qm) => qm.mission_id === mission.id,
              );
              if (missionQueuedMessages.length > 0) {
                const queuedIds = new Set(
                  missionQueuedMessages.map((qm) => qm.id),
                );
                historyItems = historyItems.map((item) =>
                  item.kind === "user" && queuedIds.has(item.id)
                    ? { ...item, queued: true }
                    : item,
                );
                const existingIds = new Set(
                  historyItems.map((item) => item.id),
                );
                const newQueuedItems: ChatItem[] = missionQueuedMessages
                  .filter((qm) => !existingIds.has(qm.id))
                  .map((qm) => ({
                    kind: "user" as const,
                    id: qm.id,
                    content: qm.content,
                    timestamp: Date.now(),
                    agent: qm.agent ?? undefined,
                    queued: true,
                  }));
                historyItems = [...historyItems, ...newQueuedItems];
              }
              setItems(historyItems);
              adjustVisibleItemsLimit(historyItems);
              seedPaginationStateAfterInitialLoad(
                mission.id,
                historicEventsLen,
              );
              // Also check events for desktop sessions
              applyDesktopSessionFromEvents(events);
            })
            .catch(() => {}); // Keep basic history on failure
          return;
        }

        if (lastMissionId) {
          await loadFromQuery(lastMissionId);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to get current mission:", err);
        }
      }
    };

    if (missionId) {
      loadFromQuery(missionId);
    } else {
      loadFromCurrent();
    }

    return () => {
      cancelled = true;
    };
  }, [
    searchParams,
    router,
    missionHistoryToItems,
    mergeEventItemsWithMissionHistoryFallback,
    eventsToItemsAsync,
    adjustVisibleItemsLimit,
    loadHistoryEvents,
    seedPaginationStateAfterInitialLoad,
    applyDesktopSessionState,
    applyDesktopSessionFromEvents,
    authRetryTrigger,
    setLastMissionId,
  ]);

  useEffect(() => {
    const id = viewingMission?.id ?? currentMission?.id;
    if (!id) return;
    setLastMissionId((prev) => (prev === id ? prev : id));
  }, [viewingMission?.id, currentMission?.id, setLastMissionId]);

  // Fetch running parallel missions. Primary refresh path is now
  // event-driven (see the `mission_status_changed` handler further
  // down), but a slow visibility-gated interval keeps the list
  // eventually-consistent in case we miss a state change (SSE lag,
  // out-of-band cancel, etc.).
  const refreshRunningMissions = useCallback(async () => {
    try {
      const running = await getRunningMissions();
      setRunningMissions(running);
    } catch {
      // Ignore errors — next event or tick will retry.
    }
  }, []);

  useVisibilityPolling(refreshRunningMissions, { interval: 15_000 });

  // P5-#25: client health-budget watcher. Posts to /telemetry/perf
  // whenever the 5s longtask total breaches 2s. Cheap when healthy
  // (no requests at all); refs avoid recreating the watcher on every
  // mission/item change.
  const itemsCountRef = useRef(0);
  useEffect(() => {
    itemsCountRef.current = items.length;
  }, [items]);
  useEffect(() => {
    return startHealthBudgetWatcher(
      () => viewingMissionIdRef.current,
      () => itemsCountRef.current,
    );
  }, []);

  const refreshRecentMissions = useCallback(async () => {
    try {
      const missions = await listMissions();
      setRecentMissions(missions);
    } catch (err) {
      if (isNetworkError(err)) return;
      console.error("Failed to fetch missions:", err);
    }
  }, []);

  const handleStreamDiagnostics = useCallback(
    (update: StreamDiagnosticUpdate) => {
      if (typeof update.bytes === "number") {
        perfBus.recordSseBytes(update.bytes);
      }
      if (update.url) {
        try {
          const url = new URL(update.url);
          const missionId = url.searchParams.get("mission") ?? undefined;
          perfBus.updateDiagnostics({
            missionId,
            transport: url.protocol.startsWith("ws") ? "ws" : "sse",
            streamScope: missionId ? "mission" : "global",
          });
        } catch {
          // Diagnostics only; malformed URLs still flow through normal logging.
        }
      }
      switch (update.phase) {
        case "connecting":
          streamLog("info", "connecting", { url: update.url });
          break;
        case "open":
          streamLog("info", "open", {
            url: update.url,
            status: update.status,
            headers: update.headers,
          });
          break;
        case "chunk":
          streamLog("debug", "chunk", { url: update.url, bytes: update.bytes });
          break;
        case "event":
          streamLog("debug", "event", { url: update.url, bytes: update.bytes });
          break;
        case "closed":
          streamLog("warn", "closed", { url: update.url, bytes: update.bytes });
          break;
        case "error":
          streamLog("error", "error", {
            url: update.url,
            status: update.status,
            error: update.error,
          });
          break;
      }

      setStreamDiagnostics((prev) => {
        const next: StreamDiagnosticsState = { ...prev };
        if (update.url) next.url = update.url;

        switch (update.phase) {
          case "connecting":
            next.phase = "connecting";
            next.lastError = null;
            next.bytes = 0;
            next.status = undefined;
            next.contentType = undefined;
            next.cacheControl = undefined;
            next.transferEncoding = undefined;
            next.contentEncoding = undefined;
            next.server = undefined;
            next.via = undefined;
            next.lastEventAt = undefined;
            next.lastChunkAt = undefined;
            break;
          case "open":
            next.phase = "open";
            next.status = update.status;
            if (update.headers) {
              next.contentType = update.headers["content-type"] ?? null;
              next.cacheControl = update.headers["cache-control"] ?? null;
              next.transferEncoding =
                update.headers["transfer-encoding"] ?? null;
              next.contentEncoding = update.headers["content-encoding"] ?? null;
              next.server = update.headers["server"] ?? null;
              next.via = update.headers["via"] ?? null;
            }
            break;
          case "chunk":
            next.phase = next.phase === "error" ? "error" : "streaming";
            next.lastChunkAt = update.timestamp;
            if (typeof update.bytes === "number") next.bytes = update.bytes;
            break;
          case "event":
            next.phase = next.phase === "error" ? "error" : "streaming";
            next.lastEventAt = update.timestamp;
            if (typeof update.bytes === "number") next.bytes = update.bytes;
            break;
          case "closed":
            next.phase = "closed";
            break;
          case "error":
            next.phase = "error";
            next.lastError = update.error ?? next.lastError ?? "Stream error";
            if (typeof update.bytes === "number") next.bytes = update.bytes;
            if (typeof update.status === "number") next.status = update.status;
            break;
        }

        return next;
      });
    },
    [setStreamDiagnostics],
  );

  // Refresh recent missions periodically (after the callback is defined).
  // Paused when the tab is hidden — there's nothing to update on screen
  // and backgrounded tabs don't need to keep the list warm. Event-driven
  // refresh on `mission_status_changed` keeps it live when visible.
  useVisibilityPolling(refreshRecentMissions, { interval: 30_000 });

  // Fetch desktop sessions periodically for the enhanced dropdown
  const refreshDesktopSessions = useCallback(async () => {
    try {
      const sessions = await listDesktopSessions();
      setDesktopSessions(sessions);
      // Find running sessions
      const runningSessions = sessions.filter(
        (s) => s.process_running && s.status !== "stopped",
      );
      const hasRunning = runningSessions.length > 0;

      if (hasRunning) {
        // Get current mission ID to scope auto-open behavior
        const activeMission =
          viewingMissionRef.current ?? currentMissionRef.current;
        const activeMissionId = activeMission?.id;

        // Only auto-open for sessions belonging to the current mission.
        // When expecting a desktop session (ToolCall detected but no ToolResult yet),
        // also include unattributed sessions (mission_id is null) since the backend
        // background task may not have attributed them yet.
        const expecting = expectingDesktopSessionRef.current;
        const currentMissionSessions = activeMissionId
          ? runningSessions.filter(
              (s) =>
                s.mission_id === activeMissionId ||
                (expecting && !s.mission_id),
            )
          : expecting
            ? runningSessions.filter((s) => !s.mission_id)
            : [];
        const hasCurrentMissionSession = currentMissionSessions.length > 0;

        // Auto-select first active session from current mission if current display isn't running anywhere
        if (hasCurrentMissionSession) {
          const currentIsRunningAnywhere = runningSessions.some(
            (s) => s.display === desktopDisplayId,
          );
          if (!currentIsRunningAnywhere) {
            setDesktopDisplayId(currentMissionSessions[0].display);
          }
          // Auto-open desktop panel only when there's an active session for the current mission
          if (!hasDesktopSession) {
            setHasDesktopSession(true);
            setShowDesktopStream(true);
          }
          // Clear expecting flag once we found a session
          if (expecting) {
            expectingDesktopSessionRef.current = false;
            if (desktopRapidPollRef.current) {
              clearInterval(desktopRapidPollRef.current);
              desktopRapidPollRef.current = null;
            }
          }
        }
      }
    } catch (err) {
      if (isNetworkError(err)) return;
      // Silently fail - desktop sessions are optional
    }
  }, [hasDesktopSession, desktopDisplayId]);

  useVisibilityPolling(refreshDesktopSessions, { interval: 30_000 });
  // Tear down the rapid-poll interval (used while waiting for an
  // expected desktop session to attach) on unmount, separate from the
  // main visibility-gated poller above.
  useEffect(() => {
    return () => {
      if (desktopRapidPollRef.current) {
        clearInterval(desktopRapidPollRef.current);
        desktopRapidPollRef.current = null;
      }
    };
  }, []);

  // Handle closing a desktop session
  const handleCloseDesktopSession = useCallback(
    async (display: string) => {
      setIsClosingDesktop(display);
      try {
        await closeDesktopSession(display);
        toast.success(`Desktop session ${display} closed`);
        // Refresh sessions
        await refreshDesktopSessions();
        // If we closed the currently viewed display, switch to another or hide
        if (desktopDisplayId === display) {
          const remaining = desktopSessions.filter(
            (s) => s.display !== display && s.process_running,
          );
          if (remaining.length > 0) {
            setDesktopDisplayId(remaining[0].display);
          } else {
            setShowDesktopStream(false);
            setHasDesktopSession(false);
          }
        }
      } catch (err) {
        toast.error(
          `Failed to close session: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      } finally {
        setIsClosingDesktop(null);
      }
    },
    [desktopDisplayId, desktopSessions, refreshDesktopSessions],
  );

  // Handle extending keep-alive
  const handleKeepAliveDesktopSession = useCallback(
    async (display: string) => {
      try {
        await keepAliveDesktopSession(display, 7200); // 2 hours
        toast.success(`Keep-alive extended for ${display}`);
        await refreshDesktopSessions();
      } catch (err) {
        toast.error(
          `Failed to extend keep-alive: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
    [refreshDesktopSessions],
  );

  // Global keyboard shortcut for mission switcher (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k" && !e.shiftKey) {
        e.preventDefault();
        setShowMissionSwitcher(true);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Fetch workspaces and agents for mission creation
  useEffect(() => {
    listWorkspaces()
      .then((data) => {
        setWorkspaces(data);
      })
      .catch((err) => {
        if (isNetworkError(err)) return;
        console.error("Failed to fetch workspaces:", err);
      });
  }, [authRetryTrigger]);

  // Fetch server configuration (max_iterations) from health endpoint
  useEffect(() => {
    getHealth()
      .then((data) => {
        if (data.max_iterations) {
          setMaxIterations(data.max_iterations);
        }
      })
      .catch((err) => {
        if (isNetworkError(err)) return;
        console.error("Failed to fetch health:", err);
      });
  }, []);

  // Handle cancelling a parallel mission
  const handleCancelMission = async (missionId: string) => {
    try {
      await cancelMission(missionId);
      toast.success("Mission cancelled");
      // Refresh running list
      const running = await getRunningMissions();
      setRunningMissions(running);
    } catch (err) {
      console.error("Failed to cancel mission:", err);
      toast.error("Failed to cancel mission");
    }
  };

  const handleDeleteMission = useCallback(
    async (missionId: string, label: string) => {
      if (
        !window.confirm(
          `Delete mission "${label}"? This permanently removes its events, snapshots, and pod. This cannot be undone.`,
        )
      ) {
        return;
      }
      try {
        await deleteMission(missionId);
        toast.success("Mission deleted");
        router.push("/");
      } catch (err) {
        console.error("Failed to delete mission:", err);
        toast.error("Failed to delete mission");
      }
    },
    [router],
  );

  // Fork a mission: snapshots both PVCs (workspaces + /var/lib/docker)
  // via Longhorn CSI, provisions a brand-new mission UUID + pod from
  // those snapshots on the current `:latest` image, and copies the
  // source mission's full event history. Returns immediately while
  // the backend orchestrates the snapshot dance; the new mission's
  // pod_phase streams to "ready" over SSE.
  const handleForkMission = useCallback(
    async (missionId: string, label: string) => {
      try {
        toast.info("Forking mission…");
        const result = await forkMission(missionId);
        toast.success(`Forked "${label}" — landing on the new pod`);
        router.push(`/control?mission=${result.mission_id}`);
      } catch (err) {
        console.error("Failed to fork mission:", err);
        toast.error(
          err instanceof Error ? err.message : "Failed to fork mission",
        );
      }
    },
    [router],
  );

  // Track the mission ID being fetched to prevent race conditions
  const fetchingMissionIdRef = useRef<string | null>(null);
  const pendingMissionNavRef = useRef<string | null>(null);
  const handleViewMissionLoadingRef = useRef<string | null>(null);

  // Handle switching which mission we're viewing
  const handleViewMission = useCallback(
    async (missionId: string) => {
      const previousViewingId = viewingMissionIdRef.current;
      const previousViewingMission = viewingMissionRef.current;

      // Clear pending thinking state to prevent stale content from appearing in new mission
      if (thinkingFlushTimeoutRef.current) {
        clearTimeout(thinkingFlushTimeoutRef.current);
        thinkingFlushTimeoutRef.current = null;
      }
      pendingThinkingRef.current = null;
      if (streamFlushTimeoutRef.current) {
        clearTimeout(streamFlushTimeoutRef.current);
        streamFlushTimeoutRef.current = null;
      }
      pendingStreamRef.current = null;

      setViewingMissionId(missionId);
      fetchingMissionIdRef.current = missionId;
      handleViewMissionLoadingRef.current = missionId;
      setMissionLoading(true);

      // Update URL immediately so it's shareable/bookmarkable
      router.replace(`/control?mission=${missionId}`, { scroll: false });

      // Always load fresh history from API when switching missions
      // This ensures we don't show stale cached events
      try {
        // Load mission, events, and queue in parallel for faster load
        const [mission, events, queuedMessages] = await Promise.all([
          getMission(missionId),
          loadHistoryEvents(missionId).catch(() => null), // Don't fail if events unavailable
          getQueue().catch(() => []), // Don't fail if queue unavailable
        ]);

        // Race condition guard: only update if this is still the mission we want
        if (fetchingMissionIdRef.current !== missionId) {
          return; // Another mission was requested, discard this response
        }

        // Use events if available, otherwise fall back to basic history
        let historyItems = events
          ? mergeEventItemsWithMissionHistoryFallback(
              await eventsToItemsAsync(events, mission),
              mission,
            )
          : missionHistoryToItems(mission);

        // Capture pre-queue length so pagination doesn't clip queued items
        // (see `seedPaginationStateAfterInitialLoad`).
        const historicEventsLen = historyItems.length;
        // Merge queued messages that belong to this mission
        const missionQueuedMessages = queuedMessages.filter(
          (qm) => qm.mission_id === missionId,
        );
        if (missionQueuedMessages.length > 0) {
          const queuedIds = new Set(missionQueuedMessages.map((qm) => qm.id));
          historyItems = historyItems.map((item) =>
            item.kind === "user" && queuedIds.has(item.id)
              ? { ...item, queued: true }
              : item,
          );
          const existingIds = new Set(historyItems.map((item) => item.id));
          const newQueuedItems: ChatItem[] = missionQueuedMessages
            .filter((qm) => !existingIds.has(qm.id))
            .map((qm) => ({
              kind: "user" as const,
              id: qm.id,
              content: qm.content,
              timestamp: Date.now(),
              agent: qm.agent ?? undefined,
              queued: true,
            }));
          historyItems = [...historyItems, ...newQueuedItems];
        }

        setItems(historyItems);
        adjustVisibleItemsLimit(historyItems);
        seedPaginationStateAfterInitialLoad(missionId, historicEventsLen);
        // Check if mission has an active desktop session (stored metadata or fallback to history)
        applyDesktopSessionState(mission);
        // Also check events for desktop sessions
        if (events) {
          applyDesktopSessionFromEvents(events);
        }
        // Update cache with fresh data (with LRU cleanup)
        updateMissionItems(missionId, historyItems);
        setViewingMission(mission);
        if (currentMissionRef.current?.id === mission.id) {
          setCurrentMission(mission);
        }
        handleViewMissionLoadingRef.current = null;
      } catch (err) {
        console.error("Failed to load mission:", err);
        handleViewMissionLoadingRef.current = null;

        // Race condition guard: only update if this is still the mission we want
        if (fetchingMissionIdRef.current !== missionId) {
          return;
        }

        // Revert viewing state to avoid filtering out events
        const fallbackMission =
          previousViewingMission ?? currentMissionRef.current;
        if (fallbackMission) {
          setViewingMissionId(fallbackMission.id);
          setViewingMission(fallbackMission);
          setItems(missionHistoryToItems(fallbackMission));
          setVisibleItemsLimit(INITIAL_VISIBLE_ITEMS);
          applyDesktopSessionState(fallbackMission);
          router.replace(`/control?mission=${fallbackMission.id}`, {
            scroll: false,
          });
        } else if (previousViewingId && missionItems[previousViewingId]) {
          setViewingMissionId(previousViewingId);
          setViewingMission(null);
          setItems(missionItems[previousViewingId]);
          setVisibleItemsLimit(INITIAL_VISIBLE_ITEMS);
          router.replace(`/control?mission=${previousViewingId}`, {
            scroll: false,
          });
        } else {
          setViewingMissionId(null);
          setViewingMission(null);
          setItems([]);
          setVisibleItemsLimit(INITIAL_VISIBLE_ITEMS);
          setHasDesktopSession(false);
          router.replace(`/control`, { scroll: false });
        }
      } finally {
        if (fetchingMissionIdRef.current === missionId) {
          setMissionLoading(false);
          fetchingMissionIdRef.current = null;
        }
        if (handleViewMissionLoadingRef.current === missionId) {
          handleViewMissionLoadingRef.current = null;
        }
      }
    },
    [
      missionItems,
      missionHistoryToItems,
      mergeEventItemsWithMissionHistoryFallback,
      eventsToItemsAsync,
      applyDesktopSessionState,
      applyDesktopSessionFromEvents,
      adjustVisibleItemsLimit,
      loadHistoryEvents,
      seedPaginationStateAfterInitialLoad,
      updateMissionItems,
      router,
    ],
  );

  const findChatItemIdForEntryIndex = useCallback(
    (entryIndex: number, snippet?: string): string | null => {
      if (entryIndex < 0) return null;

      const historyEntrySpan = (item: GroupedItem): number => {
        if (item.kind === "user" || item.kind === "assistant") {
          return 1;
        }
        if (item.kind === "tool") {
          // Backend moment indices may count both tool_call and tool_result rows.
          return item.result === undefined ? 1 : 2;
        }
        if (item.kind === "tool_group") {
          return item.tools.reduce(
            (count, tool) => count + (tool.result === undefined ? 1 : 2),
            0,
          );
        }
        return 0;
      };
      const stringifyToolPayload = (payload: unknown): string => {
        if (payload === undefined) return "";
        if (typeof payload === "string") return payload;
        try {
          const serialized = JSON.stringify(payload);
          return serialized ?? "";
        } catch {
          return String(payload);
        }
      };
      const historyItemSearchText = (item: GroupedItem): string => {
        if (item.kind === "user" || item.kind === "assistant") {
          return item.content;
        }
        if (item.kind === "tool") {
          const argsText = stringifyToolPayload(item.args);
          const resultText = stringifyToolPayload(item.result);
          return `${item.name} ${argsText} ${resultText}`.trim();
        }
        if (item.kind === "tool_group") {
          return item.tools
            .map((tool) => {
              const argsText = stringifyToolPayload(tool.args);
              const resultText = stringifyToolPayload(tool.result);
              return `${tool.name} ${argsText} ${resultText}`.trim();
            })
            .join(" ");
        }
        return "";
      };

      let historyIndex = 0;
      for (const item of groupedItems) {
        const span = historyEntrySpan(item);
        if (span <= 0) continue;
        if (entryIndex >= historyIndex && entryIndex < historyIndex + span) {
          if (item.kind === "tool_group") {
            return item.groupId;
          }
          if (
            item.kind === "user" ||
            item.kind === "assistant" ||
            item.kind === "tool"
          ) {
            return item.id;
          }
        }
        historyIndex += span;
      }

      const normalizedSnippet = normalizeMetadataText(snippet ?? "");
      if (!normalizedSnippet) return null;
      for (const item of groupedItems) {
        if (historyEntrySpan(item) <= 0) continue;
        if (
          normalizeMetadataText(historyItemSearchText(item)).includes(
            normalizedSnippet,
          )
        ) {
          if (item.kind === "tool_group") {
            return item.groupId;
          }
          if (
            item.kind === "user" ||
            item.kind === "assistant" ||
            item.kind === "tool"
          ) {
            return item.id;
          }
        }
      }
      return null;
    },
    [groupedItems],
  );

  const focusChatItem = useCallback(
    (itemId: string, entryIndex?: number) => {
      // If the target sits inside a collapsed tool_group, the inner
      // tool rows aren't in the DOM yet — expand the enclosing group
      // so scrollIntoView has something to hit.
      const enclosingGroup = groupedItems.find(
        (g) => g.kind === "tool_group" && g.tools.some((t) => t.id === itemId),
      );
      if (enclosingGroup && enclosingGroup.kind === "tool_group") {
        setExpandedToolGroups((prev) => {
          if (prev.has(enclosingGroup.groupId)) return prev;
          const next = new Set(prev);
          next.add(enclosingGroup.groupId);
          return next;
        });
      }
      let requiredVisible = groupedItems.length;
      if (typeof entryIndex === "number" && entryIndex >= 0) {
        let historyIndex = 0;
        const groupedIndex = groupedItems.findIndex((item) => {
          const span =
            item.kind === "tool_group"
              ? item.tools.reduce(
                  (count, tool) => count + (tool.result === undefined ? 1 : 2),
                  0,
                )
              : item.kind === "tool"
                ? item.result === undefined
                  ? 1
                  : 2
                : item.kind === "user" || item.kind === "assistant"
                  ? 1
                  : 0;
          if (span <= 0) {
            return false;
          }
          const matches =
            entryIndex >= historyIndex && entryIndex < historyIndex + span;
          historyIndex += span;
          if (matches) {
            return true;
          }
          return false;
        });
        if (groupedIndex >= 0) {
          requiredVisible = Math.max(1, groupedItems.length - groupedIndex);
        }
      }

      setVisibleItemsLimit((prev) => Math.max(prev, requiredVisible));
      setHighlightedItemId(itemId);

      let attempts = 0;
      const tryFocus = () => {
        const el = document.getElementById(`chat-item-${itemId}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        attempts += 1;
        if (attempts < 6) {
          requestAnimationFrame(tryFocus);
        }
      };
      requestAnimationFrame(tryFocus);
    },
    [groupedItems],
  );

  useEffect(() => {
    if (!highlightedItemId) return;
    const timeout = window.setTimeout(() => setHighlightedItemId(null), 2400);
    return () => window.clearTimeout(timeout);
  }, [highlightedItemId]);

  useEffect(() => {
    const focus = searchParams.get("focus");
    const missionFromQuery = searchParams.get("mission");
    const rawQuery = searchParams.get("query") ?? "";
    if ((focus !== "failure" && focus !== "moment") || !missionFromQuery) {
      deepLinkFocusKeyRef.current = null;
      return;
    }
    if (!viewingMission || viewingMission.id !== missionFromQuery) return;

    const focusKey = `${focus}:${missionFromQuery}:${rawQuery}`;
    if (deepLinkFocusKeyRef.current === focusKey) return;
    deepLinkFocusKeyRef.current = focusKey;

    let cancelled = false;
    (async () => {
      const query =
        focus === "failure"
          ? "failing tool call error"
          : normalizeMetadataText(rawQuery);
      if (!query) {
        toast.error("Missing moment query");
        router.replace(`/control?mission=${missionFromQuery}`, {
          scroll: false,
        });
        return;
      }

      try {
        const results = await searchMissionMoments(query, {
          missionId: missionFromQuery,
          limit: 1,
        });
        if (cancelled) return;
        const best = results[0];
        if (!best) {
          if (focus === "failure") {
            toast.error("No failing tool call moment found");
          } else {
            toast.error("No matching moment found");
          }
          router.replace(`/control?mission=${missionFromQuery}`, {
            scroll: false,
          });
          return;
        }

        const targetId = findChatItemIdForEntryIndex(
          best.entry_index,
          best.snippet,
        );
        if (targetId) {
          focusChatItem(targetId, best.entry_index);
        } else {
          // Ensure older history is visible before failing deep-link focus.
          setVisibleItemsLimit((prev) => Math.max(prev, groupedItems.length));
          requestAnimationFrame(() => {
            const retryTargetId = findChatItemIdForEntryIndex(
              best.entry_index,
              best.snippet,
            );
            if (retryTargetId) {
              focusChatItem(retryTargetId, best.entry_index);
            } else {
              toast.error(
                "Could not locate the target moment in loaded history",
              );
            }
          });
        }
        router.replace(`/control?mission=${missionFromQuery}`, {
          scroll: false,
        });
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to search mission moments:", err);
        if (focus === "failure") {
          toast.error("Failed to locate failing tool call");
        } else {
          toast.error("Failed to locate mission moment");
        }
        router.replace(`/control?mission=${missionFromQuery}`, {
          scroll: false,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    searchParams,
    viewingMission?.id,
    router,
    focusChatItem,
    findChatItemIdForEntryIndex,
    groupedItems.length,
  ]);

  // Sync viewingMissionId with currentMission only when there's no explicit viewing mission set
  useEffect(() => {
    if (currentMission && !viewingMissionId) {
      setViewingMissionId(currentMission.id);
      setViewingMission(currentMission);
    } else if (currentMission && viewingMissionId === currentMission.id) {
      // Only update viewingMission if we're actually viewing the current mission
      setViewingMission(currentMission);
    }
  }, [currentMission, viewingMissionId]);

  // Note: We don't auto-cache items from SSE events because they may not have mission_id
  // and could be from any mission. We only cache when explicitly loading from API.

  // Handle creating a new mission
  // Returns the mission ID for the NewMissionDialog to handle navigation
  const handleNewMission = async (options?: {
    workspaceId?: string;
    agent?: string;
    modelOverride?: string;
    modelEffort?: ModelEffort;
    configProfile?: string | null;
    backend?: string;
    openInNewTab?: boolean;
    initialRepos?: RepoSelection[];
  }) => {
    try {
      setMissionLoading(true);
      const mission = await createMission({
        workspaceId: options?.workspaceId,
        agent: options?.agent,
        modelOverride: options?.modelOverride,
        modelEffort: options?.modelEffort,
        configProfile: options?.configProfile ?? undefined,
        backend: options?.backend,
        initialRepos: options?.initialRepos,
      });

      // Only update local state for same-tab navigation
      // For new tab, the new tab will load its own state
      if (!options?.openInNewTab) {
        pendingMissionNavRef.current = mission.id;
        setCurrentMission(mission);
        setViewingMission(mission);
        setViewingMissionId(mission.id);
        setItems([]);
        setHasDesktopSession(false);
      }

      // Refresh running missions to get accurate state
      const running = await getRunningMissions();
      setRunningMissions(running);
      refreshRecentMissions();
      toast.success("New mission created");
      // Return ID for dialog to handle navigation
      return { id: mission.id };
    } catch (err) {
      console.error("Failed to create mission:", err);
      toast.error(
        err instanceof Error ? err.message : "Failed to create new mission",
      );
      throw err; // Re-throw so dialog knows creation failed
    } finally {
      setMissionLoading(false);
    }
  };

  const handleUpdateMissionSettings = async (options?: {
    workspaceId?: string;
    agent?: string;
    modelOverride?: string;
    modelEffort?: ModelEffort;
    configProfile?: string | null;
    backend?: string;
    openInNewTab?: boolean;
  }) => {
    const mission = viewingMission ?? currentMission;
    if (!mission) {
      throw new Error("No mission selected");
    }
    try {
      setMissionLoading(true);
      const updated = await updateMissionSettings(mission.id, {
        backend: options?.backend,
        agent: options?.agent ?? null,
        modelOverride: options?.modelOverride ?? null,
        modelEffort: options?.modelEffort ?? null,
        configProfile: options?.configProfile ?? null,
      });

      if (currentMission?.id === updated.id) {
        setCurrentMission(updated);
      }
      if (viewingMission?.id === updated.id) {
        setViewingMission(updated);
      }
      setRecentMissions((prev) => {
        let changed = false;
        const next = prev.map((item) => {
          if (item.id !== updated.id) return item;
          changed = true;
          return { ...item, ...updated };
        });
        return changed
          ? [...next].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          : prev;
      });
      refreshRecentMissions();
      toast.success("Mission run settings updated");
      return { id: updated.id };
    } catch (err) {
      console.error("Failed to update mission settings:", err);
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to update mission settings",
      );
      throw err;
    } finally {
      setMissionLoading(false);
    }
  };

  // Handle setting mission status
  const handleSetStatus = async (status: MissionStatus) => {
    const mission = viewingMission ?? currentMission;
    if (!mission) return;
    try {
      await setMissionStatus(mission.id, status);
      if (currentMission?.id === mission.id) {
        setCurrentMission({ ...mission, status });
      }
      if (viewingMission?.id === mission.id) {
        setViewingMission({ ...mission, status });
      }
      refreshRecentMissions();
      toast.success(`Mission marked as ${status}`);
    } catch (err) {
      console.error("Failed to set mission status:", err);
      toast.error("Failed to update mission status");
    }
  };

  // Handle resuming an interrupted mission
  const handleResumeMission = async () => {
    const mission = viewingMission ?? currentMission;
    if (
      !mission ||
      !["interrupted", "blocked", "failed"].includes(mission.status)
    )
      return;
    try {
      setMissionLoading(true);
      const resumed = await resumeMission(mission.id);
      setCurrentMission(resumed);
      setViewingMission(resumed);
      setViewingMissionId(resumed.id);
      // Show basic history immediately
      const basicItems = missionHistoryToItems(resumed);
      setItems(basicItems);
      adjustVisibleItemsLimit(basicItems);
      updateMissionItems(resumed.id, basicItems);
      refreshRecentMissions();
      toast.success(
        mission.status === "blocked"
          ? "Continuing mission"
          : mission.status === "failed"
            ? "Retrying mission"
            : "Mission resumed",
      );
      // Load full events in background (including tool calls)
      loadHistoryEvents(resumed.id)
        .then(async (events) => {
          const fullItems = mergeEventItemsWithMissionHistoryFallback(
            await eventsToItemsAsync(events, resumed),
            resumed,
          );
          setItems(fullItems);
          adjustVisibleItemsLimit(fullItems);
          updateMissionItems(resumed.id, fullItems);
          // Also check events for desktop sessions
          applyDesktopSessionFromEvents(events);
        })
        .catch(() => {}); // Keep basic history on failure
    } catch (err) {
      console.error("Failed to resume mission:", err);
      toast.error("Failed to resume mission");
    } finally {
      setMissionLoading(false);
    }
  };

  const handleResumeMissionById = async (missionId: string) => {
    const activeMissionId = (viewingMission ?? currentMission)?.id;
    if (activeMissionId === missionId) {
      await handleResumeMission();
      return;
    }

    try {
      setMissionLoading(true);
      await resumeMission(missionId);
      await handleViewMission(missionId);
      refreshRecentMissions();
      toast.success("Mission resumed");
    } catch (err) {
      console.error("Failed to resume mission from switcher:", err);
      toast.error("Failed to resume mission");
    } finally {
      setMissionLoading(false);
    }
  };

  // Stable handler refs for ChatItemRow. We keep `handleResumeMission`
  // unstable (it captures a lot of scope) and bounce through a ref so
  // the identity passed to memoized rows doesn't change each render.
  const handleResumeMissionRef = useRef(handleResumeMission);
  useEffect(() => {
    handleResumeMissionRef.current = handleResumeMission;
  });
  const stableResumeMission = useCallback(() => {
    void handleResumeMissionRef.current();
  }, []);

  const handleToggleToolGroup = useCallback((groupId: string) => {
    startTransition(() => {
      setExpandedToolGroups((prev) => {
        const next = new Set(prev);
        if (next.has(groupId)) {
          next.delete(groupId);
        } else {
          next.add(groupId);
        }
        return next;
      });
    });
  }, []);

  const handleOptimisticToolResult = useCallback(
    (toolCallId: string, result: unknown) => {
      setItems((prev) =>
        prev.map((it) =>
          it.kind === "tool" && it.toolCallId === toolCallId
            ? { ...it, result }
            : it,
        ),
      );
    },
    [setItems],
  );

  const handleToolResultCommit = useCallback(
    async (toolCallId: string, name: string, result: unknown) => {
      await postControlToolResult({
        tool_call_id: toolCallId,
        name,
        result,
      });
    },
    [],
  );

  const handleOpenFailingToolCallById = useCallback(
    async (missionId: string) => {
      router.replace(`/control?mission=${missionId}&focus=failure`, {
        scroll: false,
      });
    },
    [router],
  );

  const buildFollowUpPrompt = useCallback((mission: Mission) => {
    const sourceLabel =
      mission.title?.trim() ||
      mission.short_description?.trim() ||
      `mission ${getMissionShortName(mission.id)}`;
    return `Follow up on "${sourceLabel}".\n\nSummarize current progress briefly, then continue with the next concrete steps.`;
  }, []);

  const handleFollowUpMissionById = useCallback(
    async (missionId: string) => {
      const activeMission = viewingMission ?? currentMission;
      const cachedMission =
        recentMissions.find((mission) => mission.id === missionId) ??
        (activeMission?.id === missionId ? activeMission : null);

      try {
        setMissionLoading(true);
        const sourceMission = cachedMission ?? (await getMission(missionId));
        if (!sourceMission) {
          toast.error("Source mission not found");
          return;
        }

        const followUpMission = await createMission({
          workspaceId: sourceMission.workspace_id,
          agent: sourceMission.agent || undefined,
          modelOverride: sourceMission.model_override || undefined,
          modelEffort: sourceMission.model_effort || undefined,
          backend: sourceMission.backend,
        });

        pendingMissionNavRef.current = followUpMission.id;
        setCurrentMission(followUpMission);
        setViewingMission(followUpMission);
        setViewingMissionId(followUpMission.id);
        setItems([]);
        setHasDesktopSession(false);
        setInput(buildFollowUpPrompt(sourceMission));
        setShowMissionSwitcher(false);
        router.replace(`/control?mission=${followUpMission.id}`, {
          scroll: false,
        });
        refreshRecentMissions();
        toast.success("Follow-up mission created");
      } catch (err) {
        console.error("Failed to create follow-up mission:", err);
        toast.error("Failed to create follow-up mission");
      } finally {
        setMissionLoading(false);
      }
    },
    [
      viewingMission,
      currentMission,
      recentMissions,
      buildFollowUpPrompt,
      router,
      refreshRecentMissions,
    ],
  );

  // Debouncing for thinking updates to reduce re-renders during streaming
  const pendingThinkingRef = useRef<{
    content: string;
    done: boolean;
    id: string;
    startTime: number;
  } | null>(null);
  const thinkingFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const thinkingFlushRafRef = useRef<number | null>(null);
  const thinkingIdCounterRef = useRef(0);

  const pendingStreamRef = useRef<{
    content: string;
    startTime: number;
  } | null>(null);
  const streamFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const streamFlushRafRef = useRef<number | null>(null);

  // Auto-reconnecting stream with exponential backoff
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let connectionGeneration = 0;
    let mounted = true;
    const maxReconnectDelay = 30000;
    const baseDelay = 1000;

    // Fetch initial progress for refresh resilience
    getProgress()
      .then((p) => {
        if (mounted && p.total_subtasks > 0) {
          const currentId = currentMissionRef.current?.id;
          if (currentId) {
            setProgressByMission((prev) => ({
              ...prev,
              [currentId]: {
                total: p.total_subtasks,
                completed: p.completed_subtasks,
                current: p.current_subtask,
                depth: p.current_depth,
              },
            }));
          }
        }
      })
      .catch(() => {}); // Ignore errors

    const handleEvent = (event: { type: string; data: unknown }) => {
      const data: unknown = event.data;

      // Filter events by mission_id - only show events for the mission we're viewing
      const viewingId = viewingMissionIdRef.current;
      const eventMissionId =
        isRecord(data) && data["mission_id"]
          ? String(data["mission_id"])
          : null;
      const currentMissionId = currentMissionRef.current?.id;
      perfBus.recordSseEvent("received");
      lastSseEventAtRef.current = Date.now();
      streamLog("debug", "received", {
        type: event.type,
        eventMissionId,
        viewingId,
        currentMissionId,
      });

      // If we're viewing a specific mission, filter events strictly
      if (viewingId) {
        let filterReason: string | null = null;
        // Event has a mission_id - must match viewing mission
        if (eventMissionId) {
          if (eventMissionId !== viewingId) {
            // Event is from a different mission - only allow status events
            if (event.type !== "status") {
              filterReason = "event from different mission";
            }
          }
        } else {
          // Event has NO mission_id (from main session)
          // Only show if we're viewing the current/main mission OR if currentMission
          // hasn't been loaded yet (to handle race condition during initial load)
          if (currentMissionId && viewingId !== currentMissionId) {
            // We're viewing a parallel mission, skip main session events
            if (event.type !== "status") {
              filterReason = "event has no mission_id for parallel mission";
            }
          }
        }
        if (filterReason) {
          perfBus.recordSseEvent("filtered");
          streamLog("debug", "filtered", {
            type: event.type,
            eventMissionId,
            viewingId,
            currentMissionId,
            reason: filterReason,
          });
          return;
        }
      }

      if (event.type === "status" && isRecord(data)) {
        const wasReconnecting = reconnectAttempts > 0;
        reconnectAttempts = 0;

        // Update connection state to connected
        setConnectionState("connected");
        setReconnectAttempt(0);

        // If we just reconnected, refresh the viewed mission's history to catch missed events
        if (wasReconnecting && viewingId) {
          reloadMissionHistory(viewingId);
        }

        const st = data["state"];
        const newState =
          typeof st === "string" ? (st as ControlRunState) : "idle";
        const q = data["queue_len"];

        // Status filtering: only apply UI side-effects if it matches the mission we're viewing
        const statusMissionId =
          typeof data["mission_id"] === "string" ? data["mission_id"] : null;
        const effectiveMissionId =
          statusMissionId ?? runStateMissionIdRef.current ?? null;
        let shouldApplyStatus = true;

        if (effectiveMissionId) {
          shouldApplyStatus = effectiveMissionId === viewingId;
        } else {
          // No mission id available - only apply if viewing main mission or none selected
          shouldApplyStatus =
            !viewingId || viewingId === currentMissionId || !currentMissionId;
        }

        const nextQueueLen = typeof q === "number" ? q : 0;
        setQueueLen(nextQueueLen);
        setRunStateMissionId(effectiveMissionId);

        if (shouldApplyStatus && effectiveMissionId) {
          const prevQueueLen = lastQueueLenRef.current;
          lastQueueLenRef.current = nextQueueLen;
          if (prevQueueLen !== null && nextQueueLen < prevQueueLen) {
            syncQueueForMission(effectiveMissionId);
          }
        }

        // Clear progress and auto-close desktop stream when idle for the active mission
        if (newState === "idle" && effectiveMissionId) {
          setProgressByMission((prev) => {
            if (!prev[effectiveMissionId]) return prev;
            const next = { ...prev };
            delete next[effectiveMissionId];
            return next;
          });
          if (shouldApplyStatus) {
            // Auto-close desktop stream when agent finishes, unless a session is still running.
            if (
              !hasRunningDesktopSessionForMission(effectiveMissionId) &&
              !hasDesktopSessionRef.current
            ) {
              setShowDesktopStream(false);
            }
          }
        }

        setRunState(newState);
        return;
      }

      if (event.type === "user_message" && isRecord(data)) {
        const msgId = String(data["id"] ?? Date.now());
        const msgContent = String(data["content"] ?? "");
        const hasQueuedFlag = Object.prototype.hasOwnProperty.call(
          data,
          "queued",
        );
        const queued = data["queued"] === true;
        setItems((prev) => {
          // Check if already added with this ID - if so, mark as not queued (being processed)
          const existingIndex = prev.findIndex((item) => item.id === msgId);
          if (existingIndex !== -1) {
            const existing = prev[existingIndex];
            if (existing.kind === "user") {
              const nextQueued = hasQueuedFlag ? queued : existing.queued;
              if (existing.queued !== nextQueued) {
                const updated = [...prev];
                updated[existingIndex] = { ...existing, queued: nextQueued };
                return updated;
              }
            }
            return prev;
          }

          // Check if there's a pending temp message with matching content (SSE arrived before API response)
          // We verify content to avoid mismatching with messages from other sessions/devices
          const tempIndex = prev.findIndex(
            (item) =>
              item.kind === "user" &&
              item.id.startsWith("temp-") &&
              item.content === msgContent,
          );

          if (tempIndex !== -1) {
            // Replace temp ID with server ID, mark as not queued (being processed)
            const updated = [...prev];
            const tempItem = updated[tempIndex];
            if (tempItem.kind === "user") {
              updated[tempIndex] = {
                ...tempItem,
                id: msgId,
                queued: hasQueuedFlag ? queued : tempItem.queued,
              };
            }
            return updated;
          }

          // Check if there's an existing user message with the same content but a non-server ID
          // (e.g., history-* ID from missionHistoryToItems that replaced the UUID-based item).
          // Search from the end to match the most recent message with this content,
          // and only match if the ID is not already a server-assigned UUID.
          const contentIndex = [...prev]
            .reverse()
            .findIndex(
              (item) =>
                item.kind === "user" &&
                item.content === msgContent &&
                (item.id.startsWith("history-") || item.id.startsWith("temp-")),
            );
          if (contentIndex !== -1) {
            // Convert reversed index back to forward index
            const actualIndex = prev.length - 1 - contentIndex;
            const existing = prev[actualIndex];
            if (existing.kind === "user") {
              const updated = [...prev];
              updated[actualIndex] = {
                ...existing,
                id: msgId,
                queued: hasQueuedFlag ? queued : existing.queued,
              };
              return updated;
            }
          }

          // No matching message found at all, add new (message came from another client/session)
          return [
            ...prev,
            {
              kind: "user",
              id: msgId,
              content: msgContent,
              timestamp: Date.now(),
              queued,
            },
          ];
        });
        return;
      }

      if (event.type === "assistant_message" && isRecord(data)) {
        const now = Date.now();
        // If the event carries a goal iteration (because the mission is
        // running a codex `/goal` continuation loop), stamp it onto the
        // assistant message so the chat badge reads "Iteration N · 14
        // tools" instead of the misleading per-turn "Turn complete".
        const eventMissionId =
          typeof data["mission_id"] === "string"
            ? data["mission_id"]
            : undefined;
        const goalIterationForEvent = eventMissionId
          ? goalInfoByMission[eventMissionId]?.iteration
          : undefined;
        // Parse shared_files if present
        let sharedFiles: SharedFile[] | undefined;
        if (Array.isArray(data["shared_files"])) {
          sharedFiles = (data["shared_files"] as unknown[])
            .filter(isRecord)
            .map((f) => ({
              name: String(f["name"] ?? "file"),
              url: String(f["url"] ?? ""),
              content_type: String(
                f["content_type"] ?? "application/octet-stream",
              ),
              size_bytes:
                typeof f["size_bytes"] === "number"
                  ? f["size_bytes"]
                  : undefined,
              kind: (f["kind"] as SharedFile["kind"]) ?? "other",
            }));
        }

        const resumable = data["resumable"] === true;
        // Use strict equality to match eventsToItems behavior:
        // undefined means no explicit status, only false means actual failure
        const isFailure = data["success"] === false;
        const incomingId = String(data["id"] ?? Date.now());

        // Finalize any pending thinking session when an assistant message arrives.
        if (thinkingFlushTimeoutRef.current) {
          clearTimeout(thinkingFlushTimeoutRef.current);
          thinkingFlushTimeoutRef.current = null;
        }
        if (thinkingFlushRafRef.current !== null) {
          cancelAnimationFrame(thinkingFlushRafRef.current);
          thinkingFlushRafRef.current = null;
        }
        pendingThinkingRef.current = null;
        if (streamFlushTimeoutRef.current) {
          clearTimeout(streamFlushTimeoutRef.current);
          streamFlushTimeoutRef.current = null;
        }
        if (streamFlushRafRef.current !== null) {
          cancelAnimationFrame(streamFlushRafRef.current);
          streamFlushRafRef.current = null;
        }
        pendingStreamRef.current = null;

        setItems((prev) => {
          // Mark any in-progress thinking as done instead of dropping it,
          // so the Thinking panel can show a scrollable history.
          let filtered = prev.map((it) => {
            if ((it.kind === "thinking" || it.kind === "stream") && !it.done) {
              return { ...it, done: true, endTime: now };
            }
            return it;
          });

          // When mission fails, mark all pending tool calls as failed
          // This ensures subagent headers don't stay stuck showing "Running for X"
          if (isFailure) {
            const errorMessage = String(data["content"] ?? "Mission failed");
            filtered = filtered.map((it) => {
              if (it.kind === "tool" && it.result === undefined) {
                return {
                  ...it,
                  result: { error: errorMessage, status: "failed" },
                  endTime: Date.now(),
                };
              }
              return it;
            });
          }

          const existingIdx = filtered.findIndex(
            (item) => item.kind === "assistant" && item.id === incomingId,
          );
          if (existingIdx !== -1) {
            const updated = [...filtered];
            const existing = updated[existingIdx] as Extract<
              ChatItem,
              { kind: "assistant" }
            >;
            updated[existingIdx] = {
              ...existing,
              content: String(data["content"] ?? existing.content),
              success: !isFailure,
              ...parseCostMetadata(data, {
                costCents: existing.costCents,
                costSource: existing.costSource,
              }),
              model: data["model"]
                ? String(data["model"])
                : (existing.model ?? null),
              timestamp: now,
              sharedFiles: sharedFiles ?? existing.sharedFiles,
              resumable,
              goalIteration: goalIterationForEvent ?? existing.goalIteration,
              usage: parseUsage(data["usage"]) ?? existing.usage,
            };
            return updated;
          }

          const newItem: ChatItem = {
            kind: "assistant",
            id: incomingId,
            content: String(data["content"] ?? ""),
            success: !isFailure,
            ...parseCostMetadata(data),
            model: data["model"] ? String(data["model"]) : null,
            timestamp: now,
            sharedFiles,
            resumable,
            // Stamp the current goal iteration when the mission is in
            // goal mode so the chat badge can render "Iteration N"
            // instead of the noisy per-turn "Turn complete".
            goalIteration: goalIterationForEvent,
            usage: parseUsage(data["usage"]),
          };

          const firstQueuedIdx = filtered.findIndex(
            (item) => item.kind === "user" && item.queued,
          );
          if (firstQueuedIdx === -1) {
            return [...filtered, newItem];
          }
          const updated = [...filtered];
          updated.splice(firstQueuedIdx, 0, newItem);
          return updated;
        });

        // Reset stream phase to idle when agent finishes responding
        // (Agent has completed processing and is now waiting for user input)
        setStreamDiagnostics((prev) => ({
          ...prev,
          phase: "idle",
        }));

        // Auto-generate mission title on first successful assistant response (LLM-powered, best-effort).
        // Use viewingMissionIdRef (not currentMissionRef) to target the correct mission —
        // events are already filtered by viewingId, so this matches the event's mission.
        const targetMissionId = viewingMissionIdRef.current;
        const targetMission = viewingMissionRef.current;
        if (
          targetMissionId &&
          !isFailure &&
          !targetMission?.title &&
          !autoTitleAttemptedRef.current.has(targetMissionId)
        ) {
          autoTitleAttemptedRef.current.add(targetMissionId);
          const assistantContent = String(data["content"] ?? "");
          // Use itemsRef for synchronous read — avoids side effects in state updaters
          // and prevents double-firing in React StrictMode.
          const firstUser = itemsRef.current.find((it) => it.kind === "user");
          if (firstUser && firstUser.kind === "user") {
            autoGenerateMissionTitle(
              targetMissionId,
              firstUser.content,
              assistantContent,
            ).then((title) => {
              if (title) {
                // Update local mission state so the UI reflects the new title immediately
                setCurrentMission((m) =>
                  m?.id === targetMissionId ? { ...m, title } : m,
                );
                setViewingMission((m) =>
                  m?.id === targetMissionId ? { ...m, title } : m,
                );
              }
            });
          }
        }
        return;
      }

      if (event.type === "thinking" && isRecord(data)) {
        const content = String(data["content"] ?? "");
        const done = Boolean(data["done"]);
        const now = Date.now();

        // Debounced thinking updates to reduce re-renders during streaming
        const flushThinking = () => {
          const pending = pendingThinkingRef.current;
          if (!pending) return;

          setItems((prev) => {
            // Remove phase items when thinking starts
            const filtered = prev.filter((it) => it.kind !== "phase");
            let existingIdx = filtered.findIndex(
              (it) => it.kind === "thinking" && !it.done,
            );
            if (existingIdx < 0) {
              existingIdx = filtered.findLastIndex(
                (it) =>
                  it.kind === "thinking" &&
                  isStreamContinuation(pending.content, it.content),
              );
            }
            if (existingIdx >= 0) {
              const updated = [...filtered];
              const existing = updated[existingIdx] as Extract<
                ChatItem,
                { kind: "thinking" }
              >;

              // Update existing item in place with buffered content
              if (
                pending.done ||
                !pending.content ||
                existing.id === pending.id
              ) {
                updated[existingIdx] = {
                  ...existing,
                  content: pending.content || existing.content,
                  done: pending.done,
                  endTime: pending.done ? now : existing.endTime,
                };
                if (pending.done) {
                  pendingThinkingRef.current = null;
                }
                return updated;
              }

              // New thought - mark existing as done and create new
              updated[existingIdx] = {
                ...existing,
                done: true,
                endTime: now,
              };
              if (pending.done) {
                pendingThinkingRef.current = null;
              }
              return [
                ...updated,
                {
                  kind: "thinking" as const,
                  id: pending.id,
                  content: pending.content,
                  done: pending.done,
                  startTime: pending.startTime,
                  endTime: pending.done ? now : undefined,
                },
              ];
            } else {
              if (pending.done) {
                pendingThinkingRef.current = null;
              }
              return [
                ...filtered,
                {
                  kind: "thinking" as const,
                  id: pending.id,
                  content: pending.content,
                  done: pending.done,
                  startTime: pending.startTime,
                  endTime: pending.done ? now : undefined,
                },
              ];
            }
          });
        };

        // Get or create stable ID for current thinking session
        const existingPending = pendingThinkingRef.current;
        const existingContent = existingPending?.content ?? "";
        // P1-#8: tolerant continuation check (see stream-continuation.ts).
        const isContinuation = isStreamContinuation(content, existingContent);
        const shouldStartNew = Boolean(
          existingPending && !isContinuation && existingContent.trim(),
        );

        if (shouldStartNew) {
          // Finalize the previous thought before starting a new one.
          pendingThinkingRef.current = {
            content: existingContent,
            done: true,
            id:
              existingPending?.id ??
              `thinking-${thinkingIdCounterRef.current++}`,
            startTime: existingPending?.startTime ?? now,
          };
          flushThinking();
        }

        const thinkingId = shouldStartNew
          ? `thinking-${thinkingIdCounterRef.current++}`
          : (existingPending?.id ??
            `thinking-${thinkingIdCounterRef.current++}`);
        const startTime = shouldStartNew
          ? now
          : (existingPending?.startTime ?? now);

        // Buffer the content update
        pendingThinkingRef.current = {
          content: content || existingPending?.content || "",
          done,
          id: thinkingId,
          startTime,
        };

        // Clear any pending flush handles
        if (thinkingFlushTimeoutRef.current) {
          clearTimeout(thinkingFlushTimeoutRef.current);
          thinkingFlushTimeoutRef.current = null;
        }
        if (thinkingFlushRafRef.current !== null) {
          cancelAnimationFrame(thinkingFlushRafRef.current);
          thinkingFlushRafRef.current = null;
        }

        // Flush immediately on:
        //  - `done: true` (finalization)
        //  - first delta of a brand-new thought (no pending content yet)
        //  - the existing thought session was just (re)started
        // Otherwise coalesce on the next animation frame (P1-#6). The
        // previous 30 ms setTimeout caused codex's tight 10-20 ms reasoning
        // bursts to trigger a React commit per delta even though only one
        // could ever be painted per frame. rAF guarantees ≤1 commit per
        // frame regardless of arrival rate; pending content keeps
        // accumulating in `pendingThinkingRef.current` so no delta is lost.
        const shouldFlushNow =
          done || shouldStartNew || !existingPending || !existingContent;
        if (shouldFlushNow) {
          flushThinking();
        } else {
          thinkingFlushRafRef.current = requestAnimationFrame(() => {
            thinkingFlushRafRef.current = null;
            flushThinking();
          });
        }
        return;
      }

      if (event.type === "text_delta" && isRecord(data)) {
        const content = String(data["content"] ?? "");
        const now = Date.now();
        if (!content.trim()) return;

        // Debounced stream updates to reduce re-renders during rapid delta streaming.
        const flushStream = () => {
          const pending = pendingStreamRef.current;
          if (!pending) return;

          setItems((prev) => {
            // Remove phase items when streaming starts
            const filtered = prev.filter((it) => it.kind !== "phase");
            const streamId = "text_delta_latest";
            const existingIdx = filtered.findIndex(
              (it) => it.kind === "stream" && it.id === streamId,
            );
            if (existingIdx >= 0) {
              const updated = [...filtered];
              const existing = updated[existingIdx] as Extract<
                ChatItem,
                { kind: "stream" }
              >;
              const existingContent = existing.content ?? "";
              // P1-#8: tolerant continuation check (see stream-continuation.ts).
              const isContinuation = isStreamContinuation(
                pending.content,
                existingContent,
              );
              updated[existingIdx] = {
                ...existing,
                content: pending.content || existing.content,
                done: false,
                startTime:
                  isContinuation && !existing.done
                    ? existing.startTime
                    : pending.startTime,
                endTime: undefined,
              };
              return updated;
            }

            // No active stream item yet - create one.
            return [
              ...filtered,
              {
                kind: "stream" as const,
                id: "text_delta_latest",
                content: pending.content,
                done: false,
                startTime: pending.startTime,
                endTime: undefined,
              },
            ];
          });
        };

        const existingPending = pendingStreamRef.current;
        const existingContent = existingPending?.content ?? "";
        // P1-#8: tolerant continuation check (see stream-continuation.ts).
        const isContinuation = isStreamContinuation(content, existingContent);

        pendingStreamRef.current = {
          content: content || existingPending?.content || "",
          startTime: isContinuation ? (existingPending?.startTime ?? now) : now,
        };

        if (streamFlushTimeoutRef.current) {
          clearTimeout(streamFlushTimeoutRef.current);
          streamFlushTimeoutRef.current = null;
        }
        if (streamFlushRafRef.current !== null) {
          cancelAnimationFrame(streamFlushRafRef.current);
          streamFlushRafRef.current = null;
        }
        // P1-#6: schedule the flush on the next animation frame. Multiple
        // deltas arriving within the same frame collapse to a single React
        // commit because pendingStreamRef accumulates content while the
        // pending rAF callback hasn't fired yet.
        streamFlushRafRef.current = requestAnimationFrame(() => {
          streamFlushRafRef.current = null;
          flushStream();
        });
        return;
      }

      if (event.type === "text_op" && isRecord(data)) {
        const bubbleId = String(data["bubble_id"] ?? "text-op-latest");
        const rawOps = Array.isArray(data["ops"]) ? data["ops"] : [];
        const now = Date.now();

        setItems((prev) => {
          const filtered = prev.filter((it) => it.kind !== "phase");
          const existingIdx = filtered.findIndex(
            (it) => it.kind === "stream" && it.id === bubbleId,
          );
          const existing =
            existingIdx >= 0 && filtered[existingIdx]?.kind === "stream"
              ? (filtered[existingIdx] as Extract<ChatItem, { kind: "stream" }>)
              : undefined;
          let content = existing?.content ?? "";
          let finalized = false;

          for (const op of rawOps) {
            if (!isRecord(op)) continue;
            if (op["type"] === "insert") {
              const pos =
                typeof op["pos"] === "number"
                  ? Math.max(0, Math.min(op["pos"], content.length))
                  : content.length;
              const text = String(op["text"] ?? "");
              content = content.slice(0, pos) + text + content.slice(pos);
            } else if (op["type"] === "replace") {
              const range = Array.isArray(op["range"]) ? op["range"] : [];
              const start =
                typeof range[0] === "number"
                  ? Math.max(0, Math.min(range[0], content.length))
                  : 0;
              const end =
                typeof range[1] === "number"
                  ? Math.max(start, Math.min(range[1], content.length))
                  : content.length;
              const text = String(op["text"] ?? "");
              content = content.slice(0, start) + text + content.slice(end);
            } else if (op["type"] === "finalize") {
              finalized = true;
            }
          }

          if (existingIdx >= 0 && existing) {
            const updated = [...filtered];
            updated[existingIdx] = {
              ...existing,
              content,
              done: finalized,
              endTime: finalized ? now : undefined,
            };
            return updated;
          }

          return [
            ...filtered,
            {
              kind: "stream" as const,
              id: bubbleId,
              content,
              done: finalized,
              startTime: now,
              endTime: finalized ? now : undefined,
            },
          ];
        });
        return;
      }

      if (event.type === "tool_call" && isRecord(data)) {
        const name = String(data["name"] ?? "");
        const isUiTool =
          name.startsWith("ui_") ||
          name === "question" ||
          name === "AskUserQuestion";
        const toolCallId = String(data["tool_call_id"] ?? "");

        setItems((prev) => {
          const existingIdx = prev.findIndex(
            (item) => item.kind === "tool" && item.toolCallId === toolCallId,
          );
          if (existingIdx !== -1) {
            return prev;
          }

          const toolItem: ChatItem = {
            kind: "tool",
            id: `tool-${toolCallId || Date.now()}`,
            toolCallId,
            name,
            args: data["args"],
            isUiTool,
            startTime: Date.now(),
          };

          // Important: keep queued user messages at the end of the timeline.
          // If we append tool calls after a queued message, the UI can appear to "lose"
          // the assistant reply (it may be inserted before the queued message and then
          // scrolled out of view under a long tail of tools).
          const firstQueuedIdx = prev.findIndex(
            (item) => item.kind === "user" && item.queued === true,
          );
          if (firstQueuedIdx === -1) {
            return [...prev, toolItem];
          }
          const updated = [...prev];
          updated.splice(firstQueuedIdx, 0, toolItem);
          return updated;
        });

        // Detect desktop_start_session from ToolCall (Claude Code does not emit ToolResult for MCP tools)
        const isDesktopStart =
          name === "desktop_start_session" ||
          name === "desktop_desktop_start_session" ||
          name === "mcp__desktop__desktop_start_session";
        if (isDesktopStart) {
          setHasDesktopSession(true);
          setShowDesktopStream(true);
          expectingDesktopSessionRef.current = true;
          // Start rapid polling (every 2s) to pick up the session once the backend attributes it
          if (desktopRapidPollRef.current)
            clearInterval(desktopRapidPollRef.current);
          desktopRapidPollRef.current = setInterval(() => {
            refreshDesktopSessions();
          }, 2000);
          // Stop rapid polling after 30s
          setTimeout(() => {
            if (desktopRapidPollRef.current) {
              clearInterval(desktopRapidPollRef.current);
              desktopRapidPollRef.current = null;
            }
            expectingDesktopSessionRef.current = false;
          }, 30000);
        }

        return;
      }

      if (event.type === "tool_result" && isRecord(data)) {
        const toolCallId = String(data["tool_call_id"] ?? "");
        const endTime = Date.now();

        // Extract display ID from desktop_start_session tool result
        // Get tool name from the event data (preferred) or fall back to stored tool item
        const eventToolName =
          typeof data["name"] === "string" ? data["name"] : null;

        // Check for desktop_start_session right away using event data
        // This handles the case where tool_call events might be filtered or missed
        if (
          eventToolName === "desktop_start_session" ||
          eventToolName === "desktop_desktop_start_session" ||
          eventToolName === "mcp__desktop__desktop_start_session"
        ) {
          const display = extractDesktopDisplay(data["result"] ?? data);
          if (display) {
            setDesktopDisplayId(display);
            setHasDesktopSession(true);
            // Auto-open desktop stream when session starts
            setShowDesktopStream(true);
          }
        }
        // Handle desktop session close
        if (
          eventToolName === "desktop_close_session" ||
          eventToolName === "desktop_desktop_close_session" ||
          eventToolName === "mcp__desktop__desktop_close_session"
        ) {
          setHasDesktopSession(false);
          setShowDesktopStream(false);
        }

        // If eventToolName wasn't available, check stored items for desktop session tools
        // Use itemsRef for synchronous read to avoid side effects in state updaters
        if (!eventToolName) {
          const toolItem = itemsRef.current.find(
            (it) => it.kind === "tool" && it.toolCallId === toolCallId,
          );
          if (toolItem && toolItem.kind === "tool") {
            const toolName = toolItem.name;
            // Check for desktop_start_session (with or without desktop_ prefix from MCP)
            if (
              toolName === "desktop_start_session" ||
              toolName === "desktop_desktop_start_session" ||
              toolName === "mcp__desktop__desktop_start_session"
            ) {
              const display = extractDesktopDisplay(data["result"] ?? data);
              if (display) {
                setDesktopDisplayId(display);
                setHasDesktopSession(true);
                setShowDesktopStream(true);
              }
            }
            // Check for desktop_close_session
            if (
              toolName === "desktop_close_session" ||
              toolName === "desktop_desktop_close_session" ||
              toolName === "mcp__desktop__desktop_close_session"
            ) {
              setHasDesktopSession(false);
              setShowDesktopStream(false);
            }
          }
        }

        setItems((prev) =>
          prev.map((it) =>
            it.kind === "tool" && it.toolCallId === toolCallId
              ? { ...it, result: data["result"], endTime }
              : it,
          ),
        );
        return;
      }

      if (event.type === "agent_phase" && isRecord(data)) {
        const phase = String(data["phase"] ?? "");
        const detail = data["detail"] ? String(data["detail"]) : null;
        const agent = data["agent"] ? String(data["agent"]) : null;

        // Update or add phase item (we only keep one active phase at a time)
        setItems((prev) => {
          // Remove any existing phase items
          const filtered = prev.filter((it) => it.kind !== "phase");
          return [
            ...filtered,
            {
              kind: "phase" as const,
              id: `phase-${Date.now()}`,
              phase,
              detail,
              agent,
            },
          ];
        });
        return;
      }

      if (event.type === "error") {
        const msg =
          (isRecord(data) && data["message"]
            ? String(data["message"])
            : null) ?? "An error occurred.";
        const resumable = isRecord(data) && data["resumable"] === true;
        const missionId =
          isRecord(data) && typeof data["mission_id"] === "string"
            ? data["mission_id"]
            : undefined;
        streamLog("error", "error event", {
          message: msg,
          missionId,
          resumable,
        });

        if (
          msg.includes("Stream connection failed") ||
          msg.includes("Stream ended")
        ) {
          scheduleReconnect();
        } else {
          setItems((prev) => [
            ...prev,
            {
              kind: "system",
              id: `err-${Date.now()}`,
              content: msg,
              timestamp: Date.now(),
              resumable,
              missionId,
            },
          ]);
          toast.error(msg);
        }
      }

      // `stream_lagged` is emitted by the server when this SSE
      // subscriber's broadcast cursor falls behind the channel buffer
      // (chatty mission outpaces the browser tab's event handler). The
      // stream itself stays alive — we just missed a window of events.
      // Silently catch up via the existing delta-resume path
      // (`reloadMissionHistory` → `loadHistoryEvents(sinceSeq)`) so the
      // user never sees a scary error toast for what is a transient
      // back-pressure event.
      if (event.type === "stream_lagged") {
        const dropped =
          isRecord(data) && typeof data["dropped"] === "number"
            ? (data["dropped"] as number)
            : undefined;
        perfBus.updateDiagnostics({ droppedEvents: dropped ?? 0 });
        streamLog("warn", "stream_lagged; refetching", { dropped });
        const viewingId = viewingMissionIdRef.current;
        if (viewingId) {
          void reloadMissionHistory(viewingId).catch((err) => {
            streamLog("warn", "stream_lagged refetch failed", {
              err: String(err),
            });
          });
        }
        return;
      }

      // Handle mission status changes
      if (event.type === "mission_status_changed" && isRecord(data)) {
        const newStatus = String(data["status"] ?? "");
        const missionId =
          typeof data["mission_id"] === "string"
            ? data["mission_id"]
            : undefined;

        // A mission starting/stopping changes the running-missions list.
        // Fire-and-forget refresh so we don't have to rely on the 15 s
        // background tick.
        void refreshRunningMissions();

        // Always update mission status in state when it changes
        if (missionId) {
          setRecentMissions((prev) => {
            let changed = false;
            const next = prev.map((mission) => {
              if (mission.id !== missionId) return mission;
              changed = true;
              return { ...mission, status: newStatus as MissionStatus };
            });
            return changed ? next : prev;
          });
          if (currentMissionRef.current?.id === missionId) {
            setCurrentMission((prev) =>
              prev ? { ...prev, status: newStatus as MissionStatus } : prev,
            );
          }
          if (viewingMissionRef.current?.id === missionId) {
            setViewingMission((prev) =>
              prev ? { ...prev, status: newStatus as MissionStatus } : prev,
            );
          }
        }

        // When mission is no longer active, mark all pending tool calls as cancelled
        if (newStatus !== "active") {
          const now = Date.now();
          setItems((prev) =>
            prev.map((item) => {
              if (
                (item.kind === "thinking" || item.kind === "stream") &&
                !item.done
              ) {
                return { ...item, done: true, endTime: now };
              }
              if (item.kind === "tool" && item.result === undefined) {
                return {
                  ...item,
                  result: {
                    status: "cancelled",
                    reason: `Mission ${newStatus}`,
                  },
                  endTime: now,
                };
              }
              return item;
            }),
          );
          if (thinkingFlushTimeoutRef.current) {
            clearTimeout(thinkingFlushTimeoutRef.current);
            thinkingFlushTimeoutRef.current = null;
          }
          pendingThinkingRef.current = null;
          if (streamFlushTimeoutRef.current) {
            clearTimeout(streamFlushTimeoutRef.current);
            streamFlushTimeoutRef.current = null;
          }
          pendingStreamRef.current = null;

          // Reset stream phase to idle when mission completes
          // (The SSE connection stays open for the control session, but the mission is done)
          setStreamDiagnostics((prev) => ({
            ...prev,
            phase: "idle",
          }));
        }
      }

      // K8sPod backend: a per-mission pod is booting. Patch the
      // matching mission record so the card / detail view can render
      // a spinner with the latest phase + message until the pod is
      // Ready (at which point the agent spawns and normal events flow).
      if (event.type === "mission_pod_startup" && isRecord(data)) {
        const missionId =
          typeof data["mission_id"] === "string"
            ? data["mission_id"]
            : undefined;
        const phase =
          typeof data["phase"] === "string" ? data["phase"] : undefined;
        const message =
          typeof data["message"] === "string" ? data["message"] : undefined;
        if (missionId && phase) {
          const patch = { pod_phase: phase, pod_message: message ?? null };
          setRecentMissions((prev) => {
            let changed = false;
            const next = prev.map((mission) => {
              if (mission.id !== missionId) return mission;
              changed = true;
              return { ...mission, ...patch };
            });
            return changed ? next : prev;
          });
          if (currentMissionRef.current?.id === missionId) {
            setCurrentMission((prev) => (prev ? { ...prev, ...patch } : prev));
          }
          if (viewingMissionRef.current?.id === missionId) {
            setViewingMission((prev) => (prev ? { ...prev, ...patch } : prev));
          }
        }
        return;
      }

      // K8sPod backend: live docker-compose service state for the
      // per-mission pod. Server pushes the full service list every
      // time dockerd fires a container lifecycle / health event.
      if (event.type === "mission_docker_status" && isRecord(data)) {
        const missionId =
          typeof data["mission_id"] === "string"
            ? data["mission_id"]
            : undefined;
        const services = Array.isArray(data["services"])
          ? (data["services"] as import("@/lib/api").DockerServiceStatus[])
          : undefined;
        if (missionId && services) {
          setDockerServicesByMission((prev) => ({
            ...prev,
            [missionId]: services,
          }));
        }
        return;
      }

      // Sub-agent sidechain activity. Each event carries
      // `parent_tool_use_id` pointing at the boss's `Agent` tool
      // call. We bucket by that id so the dashboard can render one
      // tab per sub-agent.
      if (event.type === "subagent_tool_call" && isRecord(data)) {
        const parent =
          typeof data["parent_tool_use_id"] === "string"
            ? data["parent_tool_use_id"]
            : undefined;
        const tool_call_id =
          typeof data["tool_call_id"] === "string"
            ? data["tool_call_id"]
            : undefined;
        const name =
          typeof data["name"] === "string" ? data["name"] : undefined;
        if (parent && tool_call_id && name) {
          const item: SubagentActivity = {
            kind: "tool_call",
            tool_call_id,
            name,
            args: data["args"],
            ts: Date.now(),
          };
          setSubagentActivityByParent((prev) => ({
            ...prev,
            [parent]: [...(prev[parent] || []), item],
          }));
        }
        return;
      }
      if (event.type === "subagent_tool_result" && isRecord(data)) {
        const parent =
          typeof data["parent_tool_use_id"] === "string"
            ? data["parent_tool_use_id"]
            : undefined;
        const tool_call_id =
          typeof data["tool_call_id"] === "string"
            ? data["tool_call_id"]
            : undefined;
        const name =
          typeof data["name"] === "string" ? data["name"] : undefined;
        if (parent && tool_call_id && name) {
          const item: SubagentActivity = {
            kind: "tool_result",
            tool_call_id,
            name,
            result: data["result"],
            ts: Date.now(),
          };
          setSubagentActivityByParent((prev) => ({
            ...prev,
            [parent]: [...(prev[parent] || []), item],
          }));
        }
        return;
      }
      if (event.type === "subagent_text" && isRecord(data)) {
        const parent =
          typeof data["parent_tool_use_id"] === "string"
            ? data["parent_tool_use_id"]
            : undefined;
        const content =
          typeof data["content"] === "string" ? data["content"] : undefined;
        if (parent && content) {
          // Coalesce consecutive text deltas from the same sub-agent
          // into a single growing chunk so the UI doesn't render a
          // wall of one-token spans.
          setSubagentActivityByParent((prev) => {
            const bucket = prev[parent] || [];
            const last = bucket[bucket.length - 1];
            if (last?.kind === "text") {
              const next = bucket.slice(0, -1);
              next.push({
                kind: "text",
                content: last.content + content,
                ts: last.ts,
              });
              return { ...prev, [parent]: next };
            }
            return {
              ...prev,
              [parent]: [...bucket, { kind: "text", content, ts: Date.now() }],
            };
          });
        }
        return;
      }

      if (event.type === "goal_iteration" && isRecord(data)) {
        const missionId =
          typeof data["mission_id"] === "string"
            ? data["mission_id"]
            : undefined;
        const iteration =
          typeof data["iteration"] === "number" ? data["iteration"] : undefined;
        const objective =
          typeof data["objective"] === "string" ? data["objective"] : "";
        if (missionId && iteration !== undefined) {
          setGoalInfoByMission((prev) => ({
            ...prev,
            [missionId]: {
              iteration,
              status: prev[missionId]?.status ?? "active",
              objective: objective || prev[missionId]?.objective || "",
            },
          }));
        }
      }

      if (event.type === "goal_status" && isRecord(data)) {
        const missionId =
          typeof data["mission_id"] === "string"
            ? data["mission_id"]
            : undefined;
        const status =
          typeof data["status"] === "string" ? data["status"] : undefined;
        const objective =
          typeof data["objective"] === "string" ? data["objective"] : "";
        if (missionId && status) {
          // Clear pill on terminal statuses — keeps the UI uncluttered once
          // the goal is no longer driving the mission.
          if (
            status === "complete" ||
            status === "cleared" ||
            status === "budgetLimited" ||
            status === "aborted"
          ) {
            setGoalInfoByMission((prev) => {
              if (!(missionId in prev)) return prev;
              const next = { ...prev };
              delete next[missionId];
              return next;
            });
          } else {
            setGoalInfoByMission((prev) => ({
              ...prev,
              [missionId]: {
                iteration: prev[missionId]?.iteration ?? 0,
                status,
                objective: objective || prev[missionId]?.objective || "",
              },
            }));
          }
        }
      }

      if (event.type === "mission_title_changed" && isRecord(data)) {
        const missionId =
          typeof data["mission_id"] === "string"
            ? data["mission_id"]
            : undefined;
        const title =
          typeof data["title"] === "string" ? data["title"] : undefined;
        if (missionId && title !== undefined) {
          setRecentMissions((prev) => {
            let changed = false;
            const next = prev.map((mission) => {
              if (mission.id !== missionId) return mission;
              changed = true;
              return { ...mission, title };
            });
            return changed ? next : prev;
          });
          if (currentMissionRef.current?.id === missionId) {
            setCurrentMission((prev) => (prev ? { ...prev, title } : prev));
          }
          if (viewingMissionRef.current?.id === missionId) {
            setViewingMission((prev) => (prev ? { ...prev, title } : prev));
          }
        }
      }

      if (event.type === "mission_metadata_updated" && isRecord(data)) {
        const missionId =
          typeof data["mission_id"] === "string"
            ? data["mission_id"]
            : undefined;
        if (missionId) {
          const title =
            data["title"] === null
              ? null
              : typeof data["title"] === "string"
                ? data["title"]
                : undefined;
          const shortDescription =
            data["short_description"] === null
              ? null
              : typeof data["short_description"] === "string"
                ? data["short_description"]
                : undefined;
          const metadataUpdatedAt =
            data["metadata_updated_at"] === null
              ? null
              : typeof data["metadata_updated_at"] === "string"
                ? data["metadata_updated_at"]
                : undefined;
          const updatedAt =
            typeof data["updated_at"] === "string"
              ? data["updated_at"]
              : undefined;
          const metadataSource =
            data["metadata_source"] === null
              ? null
              : typeof data["metadata_source"] === "string"
                ? data["metadata_source"]
                : undefined;
          const metadataModel =
            data["metadata_model"] === null
              ? null
              : typeof data["metadata_model"] === "string"
                ? data["metadata_model"]
                : undefined;
          const metadataVersion =
            data["metadata_version"] === null
              ? null
              : typeof data["metadata_version"] === "string"
                ? data["metadata_version"]
                : undefined;
          setRecentMissions((prev) => {
            let changed = false;
            const next = prev.map((mission) => {
              if (mission.id !== missionId) return mission;
              changed = true;
              return {
                ...mission,
                ...(title !== undefined ? { title } : {}),
                ...(shortDescription !== undefined
                  ? { short_description: shortDescription }
                  : {}),
                ...(metadataUpdatedAt !== undefined
                  ? { metadata_updated_at: metadataUpdatedAt }
                  : {}),
                ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
                ...(metadataSource !== undefined
                  ? { metadata_source: metadataSource }
                  : {}),
                ...(metadataModel !== undefined
                  ? { metadata_model: metadataModel }
                  : {}),
                ...(metadataVersion !== undefined
                  ? { metadata_version: metadataVersion }
                  : {}),
              };
            });
            if (!changed) return prev;
            if (updatedAt === undefined) return next;
            return [...next].sort((a, b) =>
              b.updated_at.localeCompare(a.updated_at),
            );
          });

          if (currentMissionRef.current?.id === missionId) {
            setCurrentMission((prev) =>
              prev
                ? {
                    ...prev,
                    ...(title !== undefined ? { title } : {}),
                    ...(shortDescription !== undefined
                      ? { short_description: shortDescription }
                      : {}),
                    ...(metadataUpdatedAt !== undefined
                      ? { metadata_updated_at: metadataUpdatedAt }
                      : {}),
                    ...(updatedAt !== undefined
                      ? { updated_at: updatedAt }
                      : {}),
                    ...(metadataSource !== undefined
                      ? { metadata_source: metadataSource }
                      : {}),
                    ...(metadataModel !== undefined
                      ? { metadata_model: metadataModel }
                      : {}),
                    ...(metadataVersion !== undefined
                      ? { metadata_version: metadataVersion }
                      : {}),
                  }
                : prev,
            );
          }
          if (viewingMissionRef.current?.id === missionId) {
            setViewingMission((prev) =>
              prev
                ? {
                    ...prev,
                    ...(title !== undefined ? { title } : {}),
                    ...(shortDescription !== undefined
                      ? { short_description: shortDescription }
                      : {}),
                    ...(metadataUpdatedAt !== undefined
                      ? { metadata_updated_at: metadataUpdatedAt }
                      : {}),
                    ...(updatedAt !== undefined
                      ? { updated_at: updatedAt }
                      : {}),
                    ...(metadataSource !== undefined
                      ? { metadata_source: metadataSource }
                      : {}),
                    ...(metadataModel !== undefined
                      ? { metadata_model: metadataModel }
                      : {}),
                    ...(metadataVersion !== undefined
                      ? { metadata_version: metadataVersion }
                      : {}),
                  }
                : prev,
            );
          }
        }
      }

      if (event.type === "mission_settings_updated" && isRecord(data)) {
        const missionId =
          typeof data["mission_id"] === "string"
            ? data["mission_id"]
            : undefined;
        if (missionId) {
          const backend =
            typeof data["backend"] === "string" ? data["backend"] : undefined;
          const agent =
            data["agent"] === null
              ? null
              : typeof data["agent"] === "string"
                ? data["agent"]
                : undefined;
          const modelOverride =
            data["model_override"] === null
              ? null
              : typeof data["model_override"] === "string"
                ? data["model_override"]
                : undefined;
          const modelEffort =
            data["model_effort"] === null
              ? null
              : typeof data["model_effort"] === "string"
                ? data["model_effort"]
                : undefined;
          const configProfile =
            data["config_profile"] === null
              ? null
              : typeof data["config_profile"] === "string"
                ? data["config_profile"]
                : undefined;
          const sessionId =
            data["session_id"] === null
              ? null
              : typeof data["session_id"] === "string"
                ? data["session_id"]
                : undefined;
          const updatedAt =
            typeof data["updated_at"] === "string"
              ? data["updated_at"]
              : undefined;
          const applySettings = (mission: Mission): Mission => ({
            ...mission,
            ...(backend !== undefined ? { backend } : {}),
            ...(agent !== undefined ? { agent } : {}),
            ...(modelOverride !== undefined
              ? { model_override: modelOverride }
              : {}),
            ...(modelEffort !== undefined
              ? { model_effort: modelEffort as ModelEffort | null }
              : {}),
            ...(configProfile !== undefined
              ? { config_profile: configProfile }
              : {}),
            ...(sessionId !== undefined ? { session_id: sessionId } : {}),
            ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
            resumable: false,
          });

          setRecentMissions((prev) => {
            let changed = false;
            const next = prev.map((mission) => {
              if (mission.id !== missionId) return mission;
              changed = true;
              return applySettings(mission);
            });
            return changed && updatedAt !== undefined
              ? [...next].sort((a, b) =>
                  b.updated_at.localeCompare(a.updated_at),
                )
              : changed
                ? next
                : prev;
          });
          if (currentMissionRef.current?.id === missionId) {
            setCurrentMission((prev) => (prev ? applySettings(prev) : prev));
          }
          if (viewingMissionRef.current?.id === missionId) {
            setViewingMission((prev) => (prev ? applySettings(prev) : prev));
          }
        }
      }

      // Handle progress updates
      if (event.type === "progress" && isRecord(data)) {
        const progressMissionId =
          typeof data["mission_id"] === "string"
            ? data["mission_id"]
            : (currentMissionRef.current?.id ?? null);
        if (progressMissionId) {
          setProgressByMission((prev) => ({
            ...prev,
            [progressMissionId]: {
              total: Number(data["total_subtasks"] ?? 0),
              completed: Number(data["completed_subtasks"] ?? 0),
              current: data["current_subtask"] as string | null,
              depth: Number(data["depth"] ?? 0),
            },
          }));
        }
      }
    };

    const scheduleReconnect = () => {
      if (!mounted) return;
      const delay = Math.min(
        baseDelay * Math.pow(2, reconnectAttempts),
        maxReconnectDelay,
      );
      reconnectAttempts++;
      streamLog("warn", "reconnect scheduled", {
        attempt: reconnectAttempts,
        delayMs: delay,
      });
      // Update connection state to show reconnecting indicator
      setConnectionState("reconnecting");
      setReconnectAttempt(reconnectAttempts);
      reconnectTimeout = setTimeout(() => {
        if (mounted) connect();
      }, delay);
    };

    const connect = () => {
      cleanup?.();
      const generation = ++connectionGeneration;
      const missionFilter = viewingMissionIdRef.current ?? undefined;
      streamLog("info", "connecting stream", { missionFilter });
      cleanup = streamControl(
        (event) => {
          if (generation !== connectionGeneration) return;
          const data = event.data;
          const eventMissionId =
            isRecord(data) && data["mission_id"]
              ? String(data["mission_id"])
              : null;
          if (!missionFilter && viewingMissionIdRef.current && eventMissionId) {
            return;
          }
          handleEvent(event);
        },
        handleStreamDiagnostics,
        {
          missionId: missionFilter,
          sinceSeq: missionFilter
            ? missionMaxSeqRef.current.get(missionFilter)
            : undefined,
        },
      );
    };

    const initialUrlMission =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("mission")
        : null;
    if (!initialUrlMission || viewingMissionIdRef.current) {
      connect();
      streamCleanupRef.current = cleanup;
    }
    // Expose the reconnect hook so the per-mission switcher effect (below)
    // can tear down the current SSE and open a new one filtered for the
    // freshly-viewed mission. Reading from a ref keeps this effect's deps
    // empty so we don't recycle the SSE on every unrelated render.
    reconnectStreamRef.current = connect;

    return () => {
      mounted = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      cleanup?.();
      streamCleanupRef.current = null;
      // Clean up thinking debounce timeout
      if (thinkingFlushTimeoutRef.current) {
        clearTimeout(thinkingFlushTimeoutRef.current);
        thinkingFlushTimeoutRef.current = null;
      }
      if (streamFlushTimeoutRef.current) {
        clearTimeout(streamFlushTimeoutRef.current);
        streamFlushTimeoutRef.current = null;
      }
      pendingStreamRef.current = null;
    };
  }, [setItems]);

  const status = useMemo(() => statusLabel(viewingRunState), [viewingRunState]);
  const StatusIcon = status.Icon;

  const streamHints = useMemo(() => {
    void diagTick;
    const hints: string[] = [];
    const ct = streamDiagnostics.contentType;
    if (ct && !ct.toLowerCase().includes("text/event-stream")) {
      hints.push(`Content-Type is "${ct}" (expected text/event-stream).`);
    }
    const ce = streamDiagnostics.contentEncoding;
    if (ce && ce !== "identity") {
      hints.push(`Content-Encoding is "${ce}". Disable gzip for SSE.`);
    }
    if (
      streamDiagnostics.phase === "open" ||
      streamDiagnostics.phase === "streaming"
    ) {
      const lastChunkAge = streamDiagnostics.lastChunkAt
        ? Date.now() - streamDiagnostics.lastChunkAt
        : null;
      if (lastChunkAge !== null && lastChunkAge > 30000) {
        hints.push(
          "No SSE chunks for >30s. Likely proxy buffering or connection drops.",
        );
      }
    }
    if (
      typeof streamDiagnostics.status === "number" &&
      streamDiagnostics.status >= 400
    ) {
      hints.push(`Stream request returned HTTP ${streamDiagnostics.status}.`);
    }
    return hints;
  }, [streamDiagnostics, diagTick]);

  const handleCopyDiagnostics = useCallback(async () => {
    const mission = viewingMission ?? currentMission;
    const payload = {
      captured_at: new Date().toISOString(),
      mission: mission
        ? {
            id: mission.id,
            status: mission.status,
            title: mission.title,
            workspace_id: mission.workspace_id,
            workspace_name: mission.workspace_name,
          }
        : null,
      stream: {
        phase: streamDiagnostics.phase,
        status: streamDiagnostics.status,
        bytes: streamDiagnostics.bytes,
        last_event: streamDiagnostics.lastEventAt,
        last_error: streamDiagnostics.lastError,
      },
      connection_state: connectionState,
      reconnect_attempt: reconnectAttempt,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      toast.success("Copied debug info");
    } catch {
      toast.error("Failed to copy");
    }
  }, [
    connectionState,
    reconnectAttempt,
    streamDiagnostics,
    viewingMission,
    currentMission,
  ]);

  // Handler for EnhancedInput that takes a payload with content and optional agent
  const handleEnhancedSubmit = useCallback(
    async (payload: SubmitPayload) => {
      const { content, agent } = payload;
      const trimmedContent = content.trim();
      if (!trimmedContent) return;

      // Guard against double-submission (e.g., double-click, React StrictMode)
      if (submittingRef.current) {
        console.debug("[control] ignoring duplicate submission");
        return;
      }
      submittingRef.current = true;

      const targetMissionId = viewingMissionIdRef.current;
      const tempId = crypto.randomUUID();
      const timestamp = Date.now();
      const hasExistingUserMessages = items.some(
        (item) => item.kind === "user",
      );
      const willBeQueued = isBusy && hasExistingUserMessages;

      const restoreFailedOptimisticSend = () => {
        setItems((prev) => prev.filter((item) => item.id !== tempId));
        enhancedInputRef.current?.restoreDraft(trimmedContent, agent ?? null);
        setInput(trimmedContent);
        saveControlDraftForMission(trimmedContent, targetMissionId);
      };

      // Acknowledge the user's send immediately, before any mission sync or
      // network round-trip. If sync/post fails below, the optimistic row is
      // removed and the draft is restored.
      setItems((prev) => [
        ...prev,
        {
          kind: "user" as const,
          id: tempId,
          content: trimmedContent,
          timestamp,
          queued: willBeQueued,
        },
      ]);
      enhancedInputRef.current?.clear();
      setInput("");
      saveControlDraftForMission("", targetMissionId);
      // Force-scroll to bottom on send. The user explicitly submitted, so
      // they want to see their own message + the "Agent is working…"
      // indicator + the streaming response, regardless of where they had
      // scrolled to read older context. `scrollToBottom` flips the
      // hook's `isAtBottomRef` to true so the layout-effect auto-scroll
      // (triggered by the new item) actually fires.
      scrollToBottom();

      // Sync mission state before sending (backend needs current_mission set correctly).
      // This now happens after the optimistic row so slow mission sync does not
      // make the Send button feel ignored.
      if (targetMissionId) {
        try {
          let mission = await loadMission(targetMissionId);

          if (!mission) {
            restoreFailedOptimisticSend();
            toast.error("Mission not found");
            submittingRef.current = false;
            return;
          }

          // If the mission is in a resumable state (failed/interrupted/blocked),
          // Resume/sync it first before sending the message.
          // Use skipMessage to avoid the automatic resume message
          // since the user is about to send their own custom message.
          if (["failed", "interrupted", "blocked"].includes(mission.status)) {
            mission = await resumeMission(mission.id, { skipMessage: true });
          }

          setCurrentMission(mission);
          setViewingMission(mission);
          setViewingMissionId(mission.id);
          // Don't sync items from persisted history here - the local items state
          // is the source of truth and may contain SSE-delivered content that
          // hasn't been persisted yet. Replacing items would cause messages to disappear.
          applyDesktopSessionState(mission);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error("Failed to sync mission before sending:", err);
          restoreFailedOptimisticSend();
          toast.error(
            `Failed to sync mission: ${errMsg}. Check API connection in Settings.`,
          );
          submittingRef.current = false;
          return;
        }
      }

      try {
        // Send message with mission_id - backend handles routing (main vs parallel)
        const { id, queued } = await postControlMessageWithRetry(
          trimmedContent,
          {
            agent: agent || undefined,
            mission_id: targetMissionId || undefined,
            client_message_id: tempId,
          },
        );
        setItems((prev) => {
          // Check if SSE already added this message (race condition where SSE arrives before API response)
          // If so, just remove the temp message to avoid duplicates
          const sseAlreadyAdded = prev.some(
            (item) => item.id === id && item.id !== tempId,
          );
          if (sseAlreadyAdded) {
            return prev.filter((item) => item.id !== tempId);
          }

          const otherUserMessages = prev.filter(
            (item) => item.kind === "user" && item.id !== tempId,
          );
          const isFirstMessage = otherUserMessages.length === 0;
          const effectiveQueued = isFirstMessage ? false : queued;
          return prev.map((item) =>
            item.id === tempId
              ? { ...item, id, queued: effectiveQueued }
              : item,
          );
        });
      } catch (err) {
        console.error(err);
        // Restore via the imperative handle so a locked-agent badge is
        // reinstated instead of surfacing as a raw "@agent " prefix.
        // Use `trimmedContent` — it's what the optimistic item and the
        // failed API call carried, so the restored draft matches what
        // the user actually sent. Leading/trailing whitespace in
        // `content` is intentionally dropped here.
        restoreFailedOptimisticSend();
        toast.error("Failed to send message");
      } finally {
        submittingRef.current = false;
      }
    },
    [
      items,
      isBusy,
      applyDesktopSessionState,
      missionHistoryToItems,
      scrollToBottom,
    ],
  );

  const handleStop = async () => {
    const targetId = viewingMissionIdRef.current;
    if (targetId) {
      await handleCancelMission(targetId);
      return;
    }
    try {
      await cancelControl();
      toast.success("Cancelled");
    } catch (err) {
      console.error(err);
      toast.error("Failed to cancel");
    }
  };

  const syncQueueForMission = useCallback(async (missionId: string) => {
    if (!missionId || syncingQueueRef.current) return;
    syncingQueueRef.current = true;
    try {
      const queuedMessages = await getQueue();
      const queuedForMission = queuedMessages.filter(
        (qm) => qm.mission_id === missionId,
      );
      const queuedIds = new Set(queuedForMission.map((qm) => qm.id));

      setItems((prev) =>
        prev.map((item) => {
          if (item.kind !== "user") return item;
          if (item.id.startsWith("temp-")) return item;
          const shouldBeQueued = queuedIds.has(item.id);
          if (item.queued === shouldBeQueued) return item;
          return { ...item, queued: shouldBeQueued };
        }),
      );
    } catch (err) {
      console.warn("[control] failed to sync queue", err);
    } finally {
      syncingQueueRef.current = false;
    }
  }, [setItems]);

  // Reload mission history from the API. Used for visibility change,
  // periodic sync, and SSE reconnect catch-up.
  //
  // Fast path: when we know our per-mission max `sequence`, we ask for
  // `since_seq=N` and get back only the events we missed — typically a
  // handful per 15s tick. We merge those into the existing items state
  // in place instead of rebuilding it from scratch, so React only has
  // to re-render appended rows.
  //
  // Slow path: first visit or missing seq — fall back to the old
  // full-rebuild flow (last MAX_EVENTS events, recompute everything).
  const reloadMissionHistory = useCallback(
    async (missionId: string) => {
      try {
        const knownSeq = missionMaxSeqRef.current.get(missionId) ?? 0;

        if (knownSeq > 0) {
          const [mission, deltaEvents, queuedMessages] = await Promise.all([
            getMission(missionId),
            loadHistoryEvents(missionId, { sinceSeq: knownSeq }).catch(
              () => null,
            ),
            getQueue().catch(() => []),
          ]);
          if (viewingMissionIdRef.current !== missionId) return;

          // The delta merge path is intentionally simple: it appends
          // only items whose `id` is not already present. That's safe
          // for purely additive event types (user_message,
          // assistant_message of a finished turn, tool_call), but is
          // wrong whenever the historical-derived item would need to
          // *update* an existing live row instead of be appended:
          //
          //   1. `tool_result` whose matching `tool_call` arrived in a
          //      prior tick — `eventsToItems` rebuilds `toolCallMap`
          //      per pass, so the result has nothing to attach to and
          //      a naive merge leaves the tool row stuck "running".
          //   2. `thinking` / `text_delta` whose live counterpart in
          //      `items` is the in-flight SSE row keyed off synthetic
          //      ids (`text_delta_latest`, `thinking-…`). The
          //      historical event materializes as `event-<id>` instead,
          //      so the append path silently duplicates the row,
          //      stale "active" thoughts pile up in the side panel,
          //      and the live row's `done` flag never flips.
          //   3. `assistant_message` whose live counterpart is the
          //      same — the SSE-injected row gets shadowed by a
          //      duplicate from history without its updated metadata.
          //
          // For (1) we have a structured signal (orphan tool_result).
          // For (2)/(3) the cheapest correct thing is to fall through
          // to the full reload whenever the delta touches an event
          // type that we know lives in items under a synthetic id.
          let needsFullReload = false;
          if (deltaEvents && deltaEvents.length > 0) {
            const deltaToolCallIds = new Set<string>();
            for (const ev of deltaEvents) {
              if (ev.event_type === "tool_call" && ev.tool_call_id) {
                deltaToolCallIds.add(ev.tool_call_id);
              }
            }
            const hasOrphanToolResult = deltaEvents.some(
              (ev) =>
                ev.event_type === "tool_result" &&
                !!ev.tool_call_id &&
                !deltaToolCallIds.has(ev.tool_call_id),
            );
            // Detect overlap with a live SSE row (case 2/3). We only
            // care when an in-flight stream/thinking row is currently
            // mounted; otherwise eventsToItems' `event-<id>` items can
            // safely append.
            const hasLiveStreamingRow = itemsRef.current.some(
              (it) =>
                (it.kind === "stream" && it.id === "text_delta_latest") ||
                (it.kind === "thinking" && !it.done),
            );
            const deltaTouchesStreamingTypes = deltaEvents.some(
              (ev) =>
                ev.event_type === "thinking" ||
                ev.event_type === "text_delta" ||
                ev.event_type === "assistant_message",
            );
            needsFullReload =
              hasOrphanToolResult ||
              (hasLiveStreamingRow && deltaTouchesStreamingTypes);
          }

          if (!needsFullReload && deltaEvents && deltaEvents.length > 0) {
            const deltaItems = eventsToItems(deltaEvents, mission);
            setItems((prev) => {
              const existingIds = new Set(prev.map((it) => it.id));
              const additions = deltaItems.filter(
                (it) => !existingIds.has(it.id),
              );
              if (additions.length === 0) return prev;
              const merged = [...prev, ...additions];
              adjustVisibleItemsLimit(merged);
              updateMissionItems(missionId, merged);
              return merged;
            });
            applyDesktopSessionFromEvents(deltaEvents);
          }

          // Queue reconciliation still needs every tick — a message
          // could move from "queued" to "processing" with no new events.
          const missionQueuedMessages = queuedMessages.filter(
            (qm) => qm.mission_id === missionId,
          );
          const queuedIds = new Set(missionQueuedMessages.map((qm) => qm.id));
          setItems((prev) => {
            let changed = false;
            const next = prev.map((item) => {
              if (item.kind !== "user") return item;
              const shouldBeQueued = queuedIds.has(item.id);
              if (!!item.queued === shouldBeQueued) return item;
              changed = true;
              return { ...item, queued: shouldBeQueued };
            });
            const existingIds = new Set(prev.map((it) => it.id));
            const newQueued: ChatItem[] = missionQueuedMessages
              .filter((qm) => !existingIds.has(qm.id))
              .map((qm) => ({
                kind: "user" as const,
                id: qm.id,
                content: qm.content,
                timestamp: Date.now(),
                agent: qm.agent ?? undefined,
                queued: true,
              }));
            if (newQueued.length === 0 && !changed) return prev;
            const merged =
              newQueued.length > 0 ? [...next, ...newQueued] : next;
            updateMissionItems(missionId, merged);
            return merged;
          });
          if (!needsFullReload) return;
          // Orphan delta — clear the cursor and fall through to the
          // full reload below so state reconstructs with full context.
          missionMaxSeqRef.current.delete(missionId);
        }

        // Full reload fallback (first load or counter reset).
        const [mission, events, queuedMessages] = await Promise.all([
          getMission(missionId),
          loadHistoryEvents(missionId).catch(() => null),
          getQueue().catch(() => []),
        ]);
        if (viewingMissionIdRef.current !== missionId) return;

        let historyItems = events
          ? mergeEventItemsWithMissionHistoryFallback(
              await eventsToItemsAsync(events, mission),
              mission,
            )
          : missionHistoryToItems(mission);

        // Pre-queue length: pagination uses this to find the live tail
        // without clipping queued items (see `seedPaginationStateAfterInitialLoad`).
        const historicEventsLen = historyItems.length;
        const missionQueuedMessages = queuedMessages.filter(
          (qm) => qm.mission_id === missionId,
        );
        if (missionQueuedMessages.length > 0) {
          const queuedIds = new Set(missionQueuedMessages.map((qm) => qm.id));
          historyItems = historyItems.map((item) =>
            item.kind === "user" && queuedIds.has(item.id)
              ? { ...item, queued: true }
              : item,
          );
          const existingIds = new Set(historyItems.map((item) => item.id));
          const newQueuedItems: ChatItem[] = missionQueuedMessages
            .filter((qm) => !existingIds.has(qm.id))
            .map((qm) => ({
              kind: "user" as const,
              id: qm.id,
              content: qm.content,
              timestamp: Date.now(),
              agent: qm.agent ?? undefined,
              queued: true,
            }));
          historyItems = [...historyItems, ...newQueuedItems];
        }

        setItems(historyItems);
        adjustVisibleItemsLimit(historyItems);
        seedPaginationStateAfterInitialLoad(missionId, historicEventsLen);
        updateMissionItems(missionId, historyItems);
        if (events) {
          applyDesktopSessionFromEvents(events);
        }
      } catch (err) {
        console.warn("[control] reloadMissionHistory failed", err);
      }
    },
    [
      loadHistoryEvents,
      eventsToItems,
      eventsToItemsAsync,
      missionHistoryToItems,
      mergeEventItemsWithMissionHistoryFallback,
      adjustVisibleItemsLimit,
      seedPaginationStateAfterInitialLoad,
      updateMissionItems,
      applyDesktopSessionFromEvents,
      setItems,
    ],
  );

  // Reload full history when the tab regains visibility to catch missed SSE events
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && viewingMissionId) {
        reloadMissionHistory(viewingMissionId);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [viewingMissionId, reloadMissionHistory]);

  // Periodically sync history for running missions to catch missed SSE
  // events. P1-#5: skip the refetch when the SSE stream is fresh (<30s
  // since the last received event). The old unconditional refetch was the
  // main /events traffic driver — on busy long-running missions it fired
  // a 5000-row trip every 15s for every open tab, costing a 1-5s longtask
  // in the dashboard reducer each time.
  useEffect(() => {
    if (!viewingMissionId || !viewingMissionIsRunning) return;
    const SSE_FRESH_WINDOW_MS = 30_000;
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const since = Date.now() - lastSseEventAtRef.current;
      if (lastSseEventAtRef.current > 0 && since < SSE_FRESH_WINDOW_MS) {
        // SSE is healthy; trust the live stream rather than refetching.
        return;
      }
      reloadMissionHistory(viewingMissionId);
    }, 15_000);
    return () => clearInterval(interval);
  }, [viewingMissionId, viewingMissionIsRunning, reloadMissionHistory]);

  // Compute queued items for the queue strip
  const queuedItems: QueueItem[] = useMemo(() => {
    return items
      .filter(
        (item): item is Extract<typeof item, { kind: "user" }> =>
          item.kind === "user" && item.queued === true,
      )
      .map((item) => ({
        id: item.id,
        content: item.content,
        agent: null, // Agent info not stored in current item structure
      }));
  }, [items]);

  // Handle removing a message from the queue
  const handleRemoveFromQueue = async (messageId: string) => {
    try {
      await removeFromQueue(messageId);
      // Optimistically remove from local state
      setItems((prev) => prev.filter((item) => item.id !== messageId));
      toast.success("Removed from queue");
    } catch (err) {
      console.error(err);
      toast.error("Failed to remove from queue");
    }
  };

  // Handle clearing all queued messages
  const handleClearQueue = async () => {
    try {
      const { cleared } = await clearQueue();
      // Optimistically remove all queued items from local state
      setItems((prev) =>
        prev.filter((item) => !(item.kind === "user" && item.queued === true)),
      );
      toast.success(
        `Cleared ${cleared} message${cleared !== 1 ? "s" : ""} from queue`,
      );
    } catch (err) {
      console.error(err);
      toast.error("Failed to clear queue");
    }
  };

  const activeMission = viewingMission ?? currentMission;
  const isMissionSwitching =
    missionLoading &&
    !!viewingMissionId &&
    activeMission?.id !== viewingMissionId;
  const workspaceNameById = useMemo(() => {
    return Object.fromEntries(workspaces.map((ws) => [ws.id, ws.name]));
  }, [workspaces]);
  const activeWorkspaceLabel =
    activeMission?.workspace_name ||
    (activeMission?.workspace_id
      ? workspaceNameById[activeMission.workspace_id]
      : undefined);
  // The Changes panel only works for K8sPod-backed missions (we
  // exec `git status` / `git diff` inside the per-mission pod).
  // Hide the Changes tab for host / container workspaces.
  const activeMissionIsK8sPod = useMemo(() => {
    if (!activeMission?.workspace_id) return false;
    const ws = workspaces.find((w) => w.id === activeMission.workspace_id);
    return ws?.workspace_type === "k8s_pod";
  }, [activeMission?.workspace_id, workspaces]);
  const activeMissionSelectorLabel = activeMission
    ? activeMission.title?.trim() ||
      activeMission.short_description?.trim() ||
      getMissionShortName(activeMission.id)
    : null;
  const missionStatus = activeMission
    ? missionStatusLabel(activeMission.status, viewingMissionIsRunning)
    : null;

  // Update favicon with mission status dot. The hook is append-only —
  // it never detaches Next.js-owned <link> elements, so the React 19
  // commit-phase `removeChild` race on unmount is impossible.
  useFaviconStatus(activeMission?.status ?? null, viewingMissionIsRunning);

  // Derive the last resolved model from assistant messages (for the debug dropdown)
  const lastResolvedModel = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "assistant" && it.model) return it.model;
    }
    return null;
  }, [items]);

  const activeMissionRole = activeMission
    ? inferMissionRole(activeMission)
    : null;

  // In-mission sub-agents: Claude Code's in-process `Task` /
  // `background_task` / `spawn_agent` / workflow-runtime subagents.
  // These run inside the harness process and never produce a separate
  // mission record — workflows orchestrate them.
  const inMissionSubagents = useMemo<SubagentEntry[]>(() => {
    const out: SubagentEntry[] = [];
    for (const item of items) {
      if (item.kind !== "tool") continue;
      if (!isSubagentTool(item.name)) continue;
      out.push({
        id: item.id,
        toolCallId: item.toolCallId,
        name: item.name,
        args: item.args,
        result: item.result,
        startTime: item.startTime,
        endTime: item.endTime,
      });
    }
    return out;
  }, [items]);

  // Show only RUNNING sub-agents in the tab strip. Completed ones
  // disappear so the strip reflects "what's happening right now"
  // rather than every Agent call this mission ever made. The boss's
  // final answer in the chat still preserves the historical record.
  const runningSubagents = useMemo<SubagentEntry[]>(
    () => inMissionSubagents.filter((s) => s.result === undefined),
    [inMissionSubagents],
  );

  // Walk chat items in reverse to find the LATEST TodoWrite call —
  // each TodoWrite is a full snapshot of the agent's plan, not a
  // diff, so only the newest one matters for the side panel.
  const latestAgentTodos = useMemo<TodoItem[] | null>(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind !== "tool") continue;
      if (!isTodoWriteTool(item.name)) continue;
      const todos = extractTodos(item.args);
      if (todos && todos.length > 0) return todos;
    }
    return null;
  }, [items]);

  // Token totals + latest-turn context occupancy. Sum is over every
  // assistant_message that carried a `usage` field. `latestInput` is
  // the input-side of the most recent turn (raw input + cached read
  // + cache creation) — Anthropic's API re-sends the entire prior
  // conversation as input each turn, so this approximates how much
  // of the model's context window is currently occupied. `output`
  // is cumulative across the whole mission since the agent only
  // ever appends.
  const missionUsage = useMemo(() => {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    let latestInput = 0;
    let latestModel: string | null = null;
    let assistantTurns = 0;
    for (const item of items) {
      if (item.kind !== "assistant" || !item.usage) continue;
      const u = item.usage;
      totalInput += u.inputTokens;
      totalOutput += u.outputTokens;
      totalCacheRead += u.cacheReadInputTokens;
      totalCacheCreate += u.cacheCreationInputTokens;
      latestInput =
        u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
      latestModel = item.model ?? latestModel;
      assistantTurns += 1;
    }
    return {
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheCreate,
      latestInput,
      latestModel,
      assistantTurns,
    };
  }, [items]);

  // Plan cards dedupe by file path: while the agent is in plan
  // mode it Writes the plan file repeatedly (every refinement).
  // Render ONLY the latest Write per `.claude/plans/<name>.md` so
  // the user always sees the current plan, not a stack of stale
  // drafts. ExitPlanMode calls never dedupe (each is a distinct
  // finalize event keyed by tool_call_id).
  const visiblePlanToolIds = useMemo<Set<string>>(() => {
    const latestIdByKey = new Map<string, string>();
    for (const item of items) {
      if (item.kind !== "tool") continue;
      const key = planToolDedupeKey(item.name, item.args, item.toolCallId);
      if (key === null) continue;
      latestIdByKey.set(key, item.id);
    }
    return new Set(latestIdByKey.values());
  }, [items]);

  const hasInMissionSubagents = runningSubagents.length > 0;

  const handleCloseSubagentsPanel = useCallback(() => {
    const missionId = activeMission?.id;
    if (missionId) {
      subagentsPanelDismissedRef.current.add(missionId);
    }
    setShowSubagentsPanel(false);
  }, [activeMission?.id]);

  const handleCloseAgentTasksPanel = useCallback(() => {
    const missionId = activeMission?.id;
    if (missionId) {
      agentTasksPanelDismissedRef.current.add(missionId);
    }
    setShowAgentTasksPanel(false);
  }, [activeMission?.id]);

  // Re-evaluate each panel's visibility when the viewed mission
  // changes: respect the per-mission dismissal set, otherwise
  // default to open.
  useEffect(() => {
    if (!viewingMissionId) return;
    setShowSubagentsPanel(
      !subagentsPanelDismissedRef.current.has(viewingMissionId),
    );
    setShowAgentTasksPanel(
      !agentTasksPanelDismissedRef.current.has(viewingMissionId),
    );
  }, [viewingMissionId]);

  // Determine if we should show the resume UI for interrupted/blocked/failed missions
  // Don't show resume UI if:
  // - Mission is running
  // - Last turn completed (assistant message at end - ready for user input)
  // - User just sent a message (waiting for assistant response)
  // Note: For failed missions, we show resume even if lastTurnCompleted (error message is last)
  const lastItem = lastNonQueuedItem ?? items[items.length - 1];
  const lastTurnCompleted = lastItem?.kind === "assistant";
  const waitingForResponse = lastItem?.kind === "user";
  const isFailed = activeMission?.status === "failed";
  const showResumeUI =
    activeMission &&
    !viewingMissionIsRunning &&
    !waitingForResponse &&
    !dismissedResumeUI &&
    (isFailed ||
      (!lastTurnCompleted &&
        (activeMission.status === "interrupted" ||
          activeMission.status === "blocked")));

  // Reset dismissedResumeUI when switching missions
  useEffect(() => {
    setDismissedResumeUI(false);
  }, [activeMission?.id]);

  return (
    <NowTickProvider>
      {/* Responsive page padding: tight on phones, breathing room
          from `sm:` up. Prevents the 24px-on-all-sides crunch on
          narrow viewports where every pixel counts. */}
      <div className="flex h-screen flex-col p-2 sm:p-4 lg:p-6">
        {/* Always-on debug overlay so any OOM-style crash leaves a trail
            we can reconstruct from sessionStorage after reload. Cheap:
            a polling tick every 2s that reads performance.memory and
            publishes a CustomEvent the parent listens to for shedding. */}
        <MissionDebugStats items={items} visibleItems={visibleItemsLimit} />

        {/* Opt-in perf overlay — `?debug=perf` only. Mounts no work in normal
            sessions; the bus and observer self-disable when the flag is off. */}
        <PerfOverlay />

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileChange}
          className="hidden"
        />

        {/* Mission Switcher Command Palette */}
        <MissionSwitcher
          open={showMissionSwitcher}
          onClose={() => setShowMissionSwitcher(false)}
          missions={recentMissions}
          runningMissions={runningMissions}
          currentMissionId={currentMission?.id}
          viewingMissionId={viewingMissionId}
          workspaceNameById={workspaceNameById}
          onSelectMission={handleViewMission}
          onCancelMission={handleCancelMission}
          onResumeMission={handleResumeMissionById}
          onOpenFailingToolCall={handleOpenFailingToolCallById}
          onFollowUpMission={handleFollowUpMissionById}
          onRefresh={refreshRecentMissions}
        />

        <MissionAutomationsDialog
          open={showAutomationsDialog}
          missionId={activeMission?.id ?? null}
          missionLabel={
            activeMission
              ? activeWorkspaceLabel
                ? `${activeWorkspaceLabel} · ${activeMission.title?.trim() || getMissionShortName(activeMission.id)}`
                : activeMission.title?.trim() ||
                  getMissionShortName(activeMission.id)
              : null
          }
          missionBackend={activeMission?.backend ?? null}
          onClose={() => setShowAutomationsDialog(false)}
        />

        {/* Changes modal — per-mission git status + diff viewer in
            a full-screen dialog. Previously rendered in the
            right-column sidecar; promoted to a modal so the diff
            pane gets the full viewport. Esc / backdrop / X close. */}
        <ChangesModal
          key={`changes-modal-${activeMission?.id ?? "none"}`}
          open={showChangesPanel && !!activeMission}
          missionId={activeMission?.id ?? null}
          onClose={() => setShowChangesPanel(false)}
          pendingOpen={pendingFileRef}
          onPendingOpenConsumed={() => setPendingFileRef(null)}
        />

        {/* Esc-Esc → restore conversation to a past checkpoint */}
        <RestoreCheckpointModal
          key={`restore-modal-${activeMission?.id ?? "none"}`}
          open={showRestoreModal && !!activeMission}
          items={items}
          missionId={activeMission?.id ?? null}
          onClose={() => setShowRestoreModal(false)}
          onRestored={() => {
            setShowRestoreModal(false);
            // Force a hydrate from the server — events were
            // truncated so the local items array is stale.
            if (activeMission?.id) {
              void loadHistoryEvents(activeMission.id);
            }
          }}
        />

        {/* Mission tab bar — horizontal strip pinned above the
            header. Renders every NON-terminal mission (active,
            pending, awaiting_user, blocked, interrupted, paused)
            from `recentMissions`. Click switches the viewing
            mission; X cancels (not deletes). Cmd-Shift-[/] cycle
            through tab order — wired below with a global keydown
            listener. */}
        <MissionTabBar
          missions={recentMissions}
          viewingMissionId={viewingMissionId}
          runningMissions={runningMissions}
          onSelect={handleViewMission}
          onCancel={handleCancelMission}
        />

        {/* Mission-scoped subtree boundary. See
            `mission-scope.tsx` for rationale. Phase 0 of the
            refactor outlined in
            ~/.claude/plans/ok-now-i-want-witty-raccoon.md
            replaces a plain `<div key=…>` wrapper with this
            component as a structural pass-through; subsequent
            phases lift mission-bound hooks into it so they
            naturally unmount on switch. */}
        <MissionScope
          key={viewingMissionId ?? "no-mission"}
          missionId={viewingMissionId}
        >

        {/* Header */}
        <div className="relative z-10 mb-3 sm:mb-6 flex items-center justify-between gap-2 lg:gap-4">
          <div className="flex items-center gap-3 min-w-0 overflow-hidden">
            {/* Unified Mission Selector */}
            <div className="relative">
              <button
                onClick={() => setShowMissionSwitcher(true)}
                className={cn(
                  "flex h-9 items-center gap-2 px-3 rounded-lg transition-colors",
                  "bg-indigo-500/20 hover:bg-indigo-500/30",
                )}
                title="Switch mission (⌘K)"
              >
                {activeMission ? (
                  <>
                    <div
                      className={cn(
                        "h-2 w-2 rounded-full shrink-0",
                        missionStatusDotClass(
                          activeMission.status,
                          viewingMissionIsRunning,
                        ),
                      )}
                      title={missionStatus?.label}
                    />
                    <span
                      className="text-sm font-medium text-white/70 truncate max-w-[180px] sm:max-w-[260px]"
                      title={activeMissionSelectorLabel ?? undefined}
                    >
                      {activeMissionSelectorLabel}
                    </span>
                  </>
                ) : (
                  <>
                    <Layers className="h-4 w-4 text-indigo-400" />
                    <span className="text-sm font-medium text-white/50">
                      No mission
                    </span>
                  </>
                )}
                <ChevronDown className="h-3 w-3 text-white/40" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5 lg:gap-2 shrink-0">
            <NewMissionDialog
              workspaces={workspaces}
              disabled={missionLoading}
              onCreate={handleNewMission}
              initialValues={
                activeMission
                  ? {
                      workspaceId: activeMission.workspace_id,
                      agent: activeMission.agent || undefined,
                      backend: activeMission.backend,
                      modelOverride: activeMission.model_override || undefined,
                      modelEffort: activeMission.model_effort || undefined,
                      configProfile: activeMission.config_profile,
                    }
                  : undefined
              }
            />

            <button
              type="button"
              onClick={() => setShowWorkbenchPanel((prev) => !prev)}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                showWorkbenchPanel
                  ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-400"
                  : "border-white/[0.06] bg-white/[0.02] text-white/70 hover:bg-white/[0.04]",
              )}
              title={
                showWorkbenchPanel
                  ? "Hide mission workbench"
                  : "Show mission workbench"
              }
            >
              <BriefcaseBusiness className="h-4 w-4" />
              <span className="hidden sm:inline">Workbench</span>
            </button>

            {/* Editor mode toggle — only when the mission has a
                per-mission pod (K8sPod). Opens the Monaco
                workspace (diff + file editor + project find). */}
            {activeMissionIsK8sPod && (
              <button
                type="button"
                onClick={() => setShowChangesPanel((v) => !v)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                  showChangesPanel
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-white/[0.06] bg-white/[0.02] text-white/70 hover:bg-white/[0.04]",
                )}
                title={
                  showChangesPanel ? "Close code editor" : "Open code editor"
                }
              >
                <Code className="h-4 w-4" />
                <span className="hidden sm:inline">Editor</span>
              </button>
            )}

            {/* Agent tasks toggle — visible whenever the agent has emitted
                at least one TodoWrite for this mission. Closing the panel
                stays closed (per-mission dismiss state); this button is the
                only path back. */}
            {latestAgentTodos && latestAgentTodos.length > 0 && (
              <button
                onClick={() => setShowAgentTasksPanel((prev) => !prev)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-sm transition-colors",
                  showAgentTasksPanel
                    ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-400"
                    : "border-white/[0.06] bg-white/[0.02] text-white/70 hover:bg-white/[0.04]",
                )}
                title={
                  showAgentTasksPanel
                    ? "Hide agent tasks panel"
                    : "Show agent tasks panel"
                }
              >
                <Flag className="h-4 w-4" />
                <span className="hidden lg:inline">Tasks</span>
                <span className="text-xs opacity-60">
                  {latestAgentTodos.length}
                </span>
              </button>
            )}

            {/* Fork mission — snapshots PVCs + spawns a fresh-image
                pod with the same conversation + workspace + docker
                state. Backend orchestrates async; we navigate to the
                new mission immediately. */}
            {activeMission && (
              <button
                onClick={() =>
                  handleForkMission(
                    activeMission.id,
                    activeMission.title?.trim() ||
                      getMissionShortName(activeMission.id),
                  )
                }
                className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-sm text-white/70 transition-colors hover:border-white/[0.10] hover:bg-white/[0.04] hover:text-white"
                title="Fork this mission onto a fresh pod (keeps disk + docker state)"
              >
                <GitFork className="h-4 w-4" />
                <span className="hidden lg:inline">Fork</span>
              </button>
            )}

            {/* Delete mission — destructive, confirms before firing.
                Hidden until we have an activeMission to act on. */}
            {activeMission && (
              <button
                onClick={() =>
                  handleDeleteMission(
                    activeMission.id,
                    activeMission.title?.trim() ||
                      getMissionShortName(activeMission.id),
                  )
                }
                className="flex items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-2 text-sm text-rose-300/80 transition-colors hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300"
                title="Delete this mission (cannot be undone)"
              >
                <Trash2 className="h-4 w-4" />
                <span className="hidden lg:inline">Delete</span>
              </button>
            )}

            {/* Desktop stream toggle with display selector - only shown when a desktop session is active */}
            {hasDesktopSession && (
              <div className="relative flex items-center">
                <button
                  onClick={() => setShowDesktopStream(!showDesktopStream)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-l-lg border px-2.5 py-2 text-sm transition-colors",
                    showDesktopStream
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : "border-white/[0.06] bg-white/[0.02] text-white/70 hover:bg-white/[0.04]",
                  )}
                  title={
                    showDesktopStream
                      ? "Hide desktop stream"
                      : "Show desktop stream"
                  }
                >
                  <Monitor className="h-4 w-4" />
                  <span className="hidden lg:inline">Desktop</span>
                  {showDesktopStream ? (
                    <PanelRightClose className="h-4 w-4" />
                  ) : (
                    <PanelRight className="h-4 w-4" />
                  )}
                </button>
                <div className="relative">
                  <button
                    onClick={() => setShowDisplaySelector(!showDisplaySelector)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-r-lg border-y border-r px-3 py-2 text-sm transition-colors",
                      showDesktopStream
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                        : "border-white/[0.06] bg-white/[0.02] text-white/70 hover:bg-white/[0.04]",
                    )}
                    title="Select display"
                  >
                    <span className="text-sm font-mono">
                      {desktopDisplayId}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  {showDisplaySelector && (
                    <div className="absolute right-0 top-full mt-1 z-50 min-w-[280px] rounded-lg border border-white/[0.06] bg-[#121214] shadow-xl">
                      {/* Show sessions from API if available, otherwise show hardcoded list */}
                      {desktopSessions.length > 0 ? (
                        <>
                          {desktopSessions.map((session, index) => (
                            <div
                              key={`${session.display}-${session.mission_id || index}`}
                              className={cn(
                                "flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-white/[0.04]",
                                desktopDisplayId === session.display
                                  ? "bg-white/[0.02]"
                                  : "",
                              )}
                            >
                              <button
                                onClick={() => {
                                  setDesktopDisplayId(session.display);
                                  setShowDisplaySelector(false);
                                }}
                                className="flex flex-1 items-center gap-2 text-left"
                              >
                                {/* Status indicator */}
                                <span
                                  className={cn(
                                    "h-2 w-2 rounded-full",
                                    !session.process_running
                                      ? "bg-gray-600"
                                      : session.status === "active"
                                        ? "bg-emerald-500"
                                        : session.status === "orphaned"
                                          ? "bg-amber-500"
                                          : "bg-gray-500",
                                  )}
                                  title={
                                    session.process_running
                                      ? session.status
                                      : "stopped"
                                  }
                                />

                                {/* Display ID */}
                                <span
                                  className={cn(
                                    "font-mono",
                                    desktopDisplayId === session.display
                                      ? "text-emerald-400"
                                      : "text-white/70",
                                  )}
                                >
                                  {session.display}
                                </span>

                                {/* Status label */}
                                <span
                                  className={cn(
                                    "text-xs",
                                    !session.process_running
                                      ? "text-white/30"
                                      : session.status === "active"
                                        ? "text-emerald-500/70"
                                        : session.status === "orphaned"
                                          ? "text-amber-500/70"
                                          : "text-white/40",
                                  )}
                                >
                                  {!session.process_running
                                    ? "Stopped"
                                    : session.status === "active"
                                      ? "Active"
                                      : session.status === "orphaned"
                                        ? "Orphaned"
                                        : session.status}
                                </span>

                                {/* Auto-close countdown for orphaned sessions */}
                                {session.status === "orphaned" &&
                                  session.auto_close_in_secs != null &&
                                  session.auto_close_in_secs > 0 && (
                                    <span className="text-xs text-amber-500/50">
                                      {Math.floor(
                                        session.auto_close_in_secs / 60,
                                      )}
                                      m left
                                    </span>
                                  )}

                                {desktopDisplayId === session.display && (
                                  <CheckCircle className="ml-auto h-3.5 w-3.5 text-emerald-400" />
                                )}
                              </button>

                              {/* Keep alive button for orphaned sessions */}
                              {session.status === "orphaned" && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleKeepAliveDesktopSession(
                                      session.display,
                                    );
                                  }}
                                  className="p-1 text-white/40 hover:text-amber-400 transition-colors"
                                  title="Extend keep-alive (+2h)"
                                >
                                  <Clock className="h-3.5 w-3.5" />
                                </button>
                              )}

                              {/* Close button */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCloseDesktopSession(session.display);
                                }}
                                disabled={isClosingDesktop === session.display}
                                className={cn(
                                  "p-1 transition-colors",
                                  isClosingDesktop === session.display
                                    ? "text-white/20"
                                    : "text-white/40 hover:text-red-400",
                                )}
                                title="Close session"
                              >
                                {isClosingDesktop === session.display ? (
                                  <Loader className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <X className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </div>
                          ))}

                          {/* Separator and cleanup action if there are orphaned sessions */}
                          {desktopSessions.some(
                            (s) => s.status === "orphaned" && s.process_running,
                          ) && (
                            <>
                              <div className="my-1 h-px bg-white/[0.06]" />
                              <AsyncButton
                                onClick={async () => {
                                  try {
                                    await cleanupOrphanedDesktopSessions();
                                    toast.success(
                                      "Orphaned sessions cleaned up",
                                    );
                                    await refreshDesktopSessions();
                                  } catch {
                                    toast.error("Failed to cleanup sessions");
                                  }
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-amber-500/70 hover:bg-white/[0.04] transition-colors disabled:cursor-not-allowed"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Close all orphaned
                              </AsyncButton>
                            </>
                          )}

                          {/* Separator and cleanup action if there are stopped sessions */}
                          {desktopSessions.some(
                            (s) => !s.process_running || s.status === "stopped",
                          ) && (
                            <>
                              <div className="my-1 h-px bg-white/[0.06]" />
                              <AsyncButton
                                onClick={async () => {
                                  try {
                                    await cleanupStoppedDesktopSessions();
                                    toast.success("Stopped sessions cleared");
                                    await refreshDesktopSessions();
                                  } catch {
                                    toast.error(
                                      "Failed to clear stopped sessions",
                                    );
                                  }
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-white/40 hover:bg-white/[0.04] transition-colors disabled:cursor-not-allowed"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Clear stopped sessions
                              </AsyncButton>
                            </>
                          )}
                        </>
                      ) : (
                        /* Fallback to hardcoded list if no sessions from API */
                        [":99", ":100", ":101", ":102"].map((display) => (
                          <button
                            key={display}
                            onClick={() => {
                              setDesktopDisplayId(display);
                              setShowDisplaySelector(false);
                            }}
                            className={cn(
                              "flex w-full items-center px-3 py-2 text-sm font-mono transition-colors hover:bg-white/[0.04]",
                              desktopDisplayId === display
                                ? "text-emerald-400"
                                : "text-white/70",
                            )}
                          >
                            {display}
                            {desktopDisplayId === display && (
                              <CheckCircle className="ml-auto h-3.5 w-3.5" />
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Status panel */}
            <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              {/* Connection status indicator - only show when not connected */}
              {connectionState !== "connected" && (
                <>
                  <div
                    className={cn(
                      "flex items-center gap-2",
                      connectionState === "reconnecting"
                        ? "text-amber-400"
                        : "text-red-400",
                    )}
                  >
                    {connectionState === "reconnecting" ? (
                      <>
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        <span className="text-sm font-medium">
                          Reconnecting
                          {reconnectAttempt > 1
                            ? ` (${reconnectAttempt})`
                            : "..."}
                        </span>
                      </>
                    ) : (
                      <>
                        <WifiOff className="h-3.5 w-3.5" />
                        <span className="text-sm font-medium">
                          Disconnected
                        </span>
                      </>
                    )}
                  </div>
                  <div className="h-4 w-px bg-white/[0.08]" />
                </>
              )}

              {/* Run state indicator with debug dropdown */}
              <div className="relative">
                <button
                  onClick={() => setShowStreamDiagnostics((prev) => !prev)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-white/[0.04]",
                    status.className,
                  )}
                  title="Click for debug info"
                >
                  <StatusIcon
                    className={cn(
                      "h-3.5 w-3.5",
                      viewingRunState !== "idle" && "animate-spin",
                    )}
                  />
                  <span className="text-sm font-medium">{status.label}</span>
                </button>

                {showStreamDiagnostics && (
                  <div className="absolute right-0 top-full z-50 mt-2 w-[280px] rounded-lg border border-white/[0.08] bg-[#121214] p-2.5 shadow-xl">
                    {/* Mission Info */}
                    {activeMission && (
                      <div className="space-y-0.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-white/40">Mission</span>
                          <span className="font-mono text-[11px] text-white/60 select-all">
                            {activeMission.id.slice(0, 8)}
                          </span>
                        </div>
                        {activeMission.workspace_name && (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/40">Workspace</span>
                            <span className="font-mono text-white/80">
                              {activeMission.workspace_name}
                            </span>
                          </div>
                        )}
                        {activeMission.agent && (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/40">Agent</span>
                            <span className="font-mono text-white/80">
                              {activeMission.agent}
                            </span>
                          </div>
                        )}
                        {activeMission.backend && (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/40">Backend</span>
                            <span className="font-mono text-white/80">
                              {activeMission.backend}
                            </span>
                          </div>
                        )}
                        {activeMission.model_override && (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/40">
                              Model override
                            </span>
                            <span
                              className="font-mono text-[11px] text-indigo-400 truncate max-w-[160px]"
                              title={activeMission.model_override}
                            >
                              {activeMission.model_override}
                            </span>
                          </div>
                        )}
                        {(activeMission.backend === "claudecode" ||
                          activeMission.backend === "codex") && (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/40">Model effort</span>
                            <select
                              value={activeMission.model_effort ?? ""}
                              onChange={(e) => {
                                const v = e.target.value;
                                void handleUpdateMissionSettings({
                                  modelEffort: (v || undefined) as
                                    | ModelEffort
                                    | undefined,
                                });
                              }}
                              disabled={missionLoading}
                              className="font-mono text-[11px] text-amber-300 bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-0.5 focus:outline-none focus:border-amber-400/50 disabled:opacity-50 max-w-[120px]"
                              title="Change the mission's reasoning effort"
                            >
                              <option value="" className="bg-[#1a1a1a]">
                                default
                              </option>
                              <option value="low" className="bg-[#1a1a1a]">
                                low
                              </option>
                              <option value="medium" className="bg-[#1a1a1a]">
                                medium
                              </option>
                              <option value="high" className="bg-[#1a1a1a]">
                                high
                              </option>
                              {activeMission.backend === "claudecode" && (
                                <option value="xhigh" className="bg-[#1a1a1a]">
                                  xhigh
                                </option>
                              )}
                              {activeMission.backend === "claudecode" && (
                                <option value="max" className="bg-[#1a1a1a]">
                                  max
                                </option>
                              )}
                            </select>
                          </div>
                        )}
                        {lastResolvedModel && (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/40">
                              Resolved model
                            </span>
                            <span
                              className="font-mono text-[11px] text-emerald-400 truncate max-w-[160px]"
                              title={lastResolvedModel}
                            >
                              {lastResolvedModel}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Stream Status */}
                    <div
                      className={cn(
                        "space-y-0.5 text-xs",
                        activeMission &&
                          "mt-2 pt-2 border-t border-white/[0.06]",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-white/40">Stream</span>
                        <span className="flex items-center gap-1.5 font-mono text-white/80">
                          <span
                            className={cn(
                              "h-1.5 w-1.5 rounded-full",
                              (streamDiagnostics.phase === "streaming" ||
                                streamDiagnostics.phase === "open") &&
                                "bg-emerald-400",
                              streamDiagnostics.phase === "connecting" &&
                                "bg-amber-400",
                              streamDiagnostics.phase === "error" &&
                                "bg-red-400",
                              (streamDiagnostics.phase === "closed" ||
                                streamDiagnostics.phase === "idle") &&
                                "bg-white/30",
                            )}
                          />
                          {streamDiagnostics.phase}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-white/40">Activity</span>
                        <span className="font-mono text-white/60 text-[11px]">
                          {formatDiagAge(streamDiagnostics.lastEventAt)}
                        </span>
                      </div>
                    </div>

                    {streamDiagnostics.lastError && (
                      <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                        {streamDiagnostics.lastError}
                      </div>
                    )}

                    {streamHints.length > 0 && (
                      <div className="mt-2 space-y-0.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                        {streamHints.map((hint) => (
                          <div key={hint}>{hint}</div>
                        ))}
                      </div>
                    )}

                    <button
                      onClick={handleCopyDiagnostics}
                      className="mt-2 w-full text-center text-[11px] text-white/40 hover:text-white/70 transition-colors"
                    >
                      Copy debug info
                    </button>
                  </div>
                )}
              </div>

              {/* Queue count */}
              <div className="h-4 w-px bg-white/[0.08]" />
              <div
                className="flex items-center gap-1.5"
                title={
                  viewingQueueLen > 0
                    ? `${viewingQueueLen} message${viewingQueueLen > 1 ? "s" : ""} waiting to be processed`
                    : "No messages queued"
                }
              >
                <span className="text-[10px] uppercase tracking-wider text-white/40">
                  Queue
                </span>
                <span
                  className={cn(
                    "text-sm font-medium tabular-nums",
                    viewingQueueLen === 0 && "text-white/70",
                    viewingQueueLen > 0 &&
                      viewingQueueLen < 3 &&
                      "text-amber-400",
                    viewingQueueLen >= 3 && "text-orange-400",
                  )}
                >
                  {viewingQueueLen}
                </span>
              </div>

              {/* Progress indicator */}
              {viewingProgress && viewingProgress.total > 0 && (
                <>
                  <div className="h-4 w-px bg-white/[0.08]" />
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-white/40">
                      Subtask
                    </span>
                    <span className="text-sm font-medium text-emerald-400 tabular-nums">
                      {Math.min(
                        viewingProgress.completed + 1,
                        viewingProgress.total,
                      )}
                      /{viewingProgress.total}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Main content area - Chat and Desktop stream side by side
            on `md:` and up. On phones we stack vertically so the
            320px-wide right column doesn't squeeze the chat to
            illegible width. */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-2 md:gap-4">
          {/* Chat container. We intentionally do NOT animate flex-grow when
          side panels (Workers / Workbench / Thinking) open: animating layout
          properties like `flex-grow` re-flows the entire (potentially huge)
          virtualized chat list every frame for the duration of the transition,
          which is the source of the "freeze" users see when clicking the
          Workers toggle. Keep the panels' own fade-in animation; let the chat
          snap to its new width in a single layout pass. */}
          <div
            className={cn(
              "flex-1 min-h-0 flex flex-col rounded-2xl glass-panel border border-white/[0.06] overflow-hidden relative",
              showDesktopStream && "flex-[2]",
            )}
          >
            {/* Tab strip above the chat — combines the sub-agent
                chips (when any are running) and a `Changes` pill
                that opens the git-diff drawer. Always renders for
                K8sPod missions so the user can pop the Changes
                view open at any time. */}
            {(hasInMissionSubagents ||
              activeMissionIsK8sPod) && (
              <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.01]">
                <div className="flex-1 min-w-0">
                  {hasInMissionSubagents ? (
                    <SubagentTabStrip
                      subagents={runningSubagents}
                      activeTab={activeSubagentTab}
                      onSelect={setActiveSubagentTab}
                    />
                  ) : (
                    <div className="px-4 py-2 text-[10px] uppercase tracking-wider text-white/30">
                      Main thread
                    </div>
                  )}
                </div>
                {/* Changes pill removed — replaced by the
                    "Editor" toggle in the topbar. */}
              </div>
            )}
            {/* Messages */}
            {/* `key={viewingMissionId}` forces the entire chat
                scroll container — virtualizer, ToolCallItem
                expansions, ThinkingGroups, SubagentChatView,
                etc. — to unmount and remount when the user
                switches missions. Without this, components hold
                refs / lifecycle state tied to the previous
                mission while React rebinds them to the new
                mission's items, producing "Cannot read
                properties of null (reading 'removeChild')"
                during commit. */}
            <div
              key={viewingMissionId ?? "no-mission"}
              ref={containerRef}
              data-testid="chat-scroll-container"
              className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6"
            >
              {/* Sub-agent tab is active → render the scoped chat
                  view for that sub-agent instead of the main thread.
                  Read-only; the composer is gated below. */}
              {activeSubagentTab && (() => {
                const sa = inMissionSubagents.find(
                  (s) => s.toolCallId === activeSubagentTab,
                );
                if (!sa) return null;
                return (
                  <SubagentChatView
                    subagent={sa}
                    activity={subagentActivityByParent[activeSubagentTab] || []}
                  />
                );
              })()}
              {!activeSubagentTab && (<>
              {/* Backwards pagination — only when there's actually more older
              history to fetch and the chat isn't empty. Click prepends the
              previous page; scroll position is preserved so the message
              currently in view stays put.
              `olderLoadState` is single-shared but tagged with `missionId`,
              so we ignore it unless it's for the mission the user is
              actually viewing. Otherwise a stale completion (or a
              still-in-flight fetch from a previously-viewed mission)
              could pin this button to a wrong "Loading…" / hidden state. */}
              {items.length > 0 &&
                olderLoadState.missionId === viewingMissionId &&
                olderLoadState.hasMore &&
                viewingMissionId && (
                  <div className="flex justify-center mb-4">
                    <button
                      type="button"
                      disabled={olderLoadState.loading}
                      onClick={() => {
                        void loadOlderHistoryEvents(viewingMissionId);
                      }}
                      className={cn(
                        "px-4 py-1.5 text-xs rounded-full border transition-colors",
                        "border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/[0.06] hover:text-white/80",
                        olderLoadState.loading && "opacity-60 cursor-wait",
                      )}
                    >
                      {olderLoadState.loading
                        ? "Loading older messages…"
                        : "Load older messages"}
                    </button>
                  </div>
                )}
              {isMissionSwitching ? (
                <ChatLoadingSkeleton />
              ) : items.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/10">
                      {viewingMissionIsRunning &&
                      activeMission?.status === "active" ? (
                        <Loader className="h-8 w-8 text-indigo-400 animate-spin" />
                      ) : (
                        <Bot className="h-8 w-8 text-indigo-400" />
                      )}
                    </div>
                    {missionLoading ? (
                      <Shimmer className="max-w-xs mx-auto" />
                    ) : viewingMissionIsRunning &&
                      activeMission?.status === "active" ? (
                      <>
                        <h2 className="text-lg font-medium text-white">
                          Agent is working...
                        </h2>
                        <p className="mt-2 text-sm text-white/40 max-w-sm">
                          Processing your request. Updates will appear here as
                          they arrive.
                        </p>
                      </>
                    ) : activeMission && activeMission.status !== "active" ? (
                      <>
                        <h2 className="text-lg font-medium text-white">
                          {activeMission.status === "interrupted"
                            ? "Mission Interrupted"
                            : activeMission.status === "blocked"
                              ? "Iteration Limit Reached"
                              : "No conversation history"}
                        </h2>
                        <p className="mt-2 text-sm text-white/40 max-w-sm">
                          {activeMission.status === "interrupted" ? (
                            <>
                              This mission was interrupted (server shutdown or
                              cancellation). Click the{" "}
                              <strong className="text-amber-400">Resume</strong>{" "}
                              button in the mission menu to continue where you
                              left off.
                            </>
                          ) : activeMission.status === "blocked" ? (
                            <>
                              The agent reached its iteration limit (
                              {maxIterations}). You can continue the mission to
                              give it more iterations.
                            </>
                          ) : activeMission.status === "failed" ? (
                            <>
                              This mission failed without producing any
                              messages.
                            </>
                          ) : activeMission.status === "not_feasible" ? (
                            <>
                              The agent determined this task was not feasible.
                            </>
                          ) : (
                            <>
                              This mission was {activeMission.status} without
                              any messages.
                              {activeMission.status === "completed" &&
                                " You can reactivate it to continue."}
                            </>
                          )}
                        </p>
                        {activeMission.status === "blocked" && (
                          <div className="mt-4 flex gap-2">
                            <button
                              onClick={() => handleResumeMission()}
                              disabled={missionLoading}
                              className="inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 transition-colors disabled:opacity-50"
                            >
                              {missionLoading ? (
                                <Loader className="h-4 w-4 animate-spin" />
                              ) : (
                                <PlayCircle className="h-4 w-4" />
                              )}
                              Continue Mission
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <h2 className="text-lg font-medium text-white">
                          Start a conversation
                        </h2>
                        <p className="mt-2 text-sm text-white/40 max-w-sm">
                          Ask the agent to do something. Messages queue while
                          it&apos;s busy
                        </p>

                        <p className="mt-4 text-xs text-white/30">
                          Tip: Paste files directly to upload to context folder
                        </p>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                // Research-backed reading width: ~66 char sweet spot
                // (UXPin / Justinmind / Untitled UI all converge on
                // 50-75 chars per line for body copy). At
                // `text-base` (16px) `max-w-4xl` (896px) gives
                // ~70-75 CPL. Bump to `max-w-5xl` on very wide
                // monitors so the chat doesn't feel narrow on
                // 1440px+ screens. `leading-relaxed` (1.625)
                // matches the 150% line-height sweet spot.
                <div className="mx-auto w-full max-w-4xl xl:max-w-5xl space-y-6">
                  <div
                    className="relative w-full"
                    style={{ height: `${chatVirtualizer.getTotalSize()}px` }}
                  >
                    {chatVirtualizer.getVirtualItems().map((virtualRow) => {
                      const item = groupedItems[virtualRow.index];
                      if (!item) return null;
                      const key = getGroupedItemKey(item);
                      const isToolGroupExpanded =
                        item.kind === "tool_group"
                          ? expandedToolGroups.has(item.groupId)
                          : false;
                      return (
                        <div
                          key={virtualRow.key}
                          ref={chatVirtualizer.measureElement}
                          data-index={virtualRow.index}
                          className="absolute left-0 top-0 w-full pb-6"
                          style={{
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          <ChatItemRow
                            item={item}
                            highlighted={highlightedItemId === key}
                            workspaceId={missionForDownloads?.workspace_id}
                            missionId={missionForDownloads?.id}
                            basePath={missionWorkingDirectory}
                            isToolGroupExpanded={isToolGroupExpanded}
                            onToggleToolGroup={handleToggleToolGroup}
                            onResume={stableResumeMission}
                            onToolResult={handleToolResultCommit}
                            onOptimisticToolResult={handleOptimisticToolResult}
                            visiblePlanToolIds={visiblePlanToolIds}
                          />
                        </div>
                      );
                    })}
                  </div>

                  {/* Show streaming indicator when running but no active thinking/phase visible inline.
                  P2-#14: the items.some + last-index lookup live in `showAgentWorkingIndicator`
                  memo so each NowTick render doesn't re-walk the whole items array. */}
                  {viewingMissionIsRunning &&
                    activeMission?.status === "active" &&
                    showAgentWorkingIndicator && (
                      <div className="flex justify-start gap-3 animate-fade-in">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/20">
                          <Bot className="h-4 w-4 text-indigo-400 animate-pulse" />
                        </div>
                        <div className="rounded-2xl rounded-tl-md bg-white/[0.03] border border-white/[0.06] px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Loader className="h-4 w-4 text-indigo-400 animate-spin" />
                            <span className="text-sm text-white/60">
                              Agent is working...
                            </span>
                          </div>
                        </div>
                      </div>
                    )}

                  {/* Waiting banner for interactive user-input tools */}
                  {hasPendingUserInput && (
                    <div className="flex justify-center py-4 animate-fade-in">
                      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 rounded-xl px-5 py-4 bg-indigo-500/10 border border-indigo-500/20">
                        <div className="flex items-center gap-3">
                          <HelpCircle className="h-5 w-5 shrink-0 text-indigo-300" />
                          <div className="text-sm">
                            <span className="font-medium text-indigo-200">
                              Waiting for your response
                            </span>
                            <p className="text-white/50">
                              The agent is paused until you answer the prompt
                              above.
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={handleShowPendingUserInput}
                          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium bg-indigo-500/20 text-indigo-200 hover:bg-indigo-500/30 border border-indigo-500/30 transition-colors"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                          Show prompt
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Stall warning banner when agent hasn't reported activity for 60+ seconds */}
                  {isViewingMissionStalled &&
                    viewingMissionId &&
                    !hasPendingUserInput && (
                      <div className="flex justify-center py-4 animate-fade-in">
                        <div
                          className={cn(
                            "flex flex-col sm:flex-row items-start sm:items-center gap-3 rounded-xl px-5 py-4",
                            isViewingMissionSeverelyStalled
                              ? "bg-red-500/10 border border-red-500/20"
                              : "bg-amber-500/10 border border-amber-500/20",
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <AlertTriangle
                              className={cn(
                                "h-5 w-5 shrink-0",
                                isViewingMissionSeverelyStalled
                                  ? "text-red-400"
                                  : "text-amber-400",
                              )}
                            />
                            <div className="text-sm">
                              <span
                                className={cn(
                                  "font-medium",
                                  isViewingMissionSeverelyStalled
                                    ? "text-red-400"
                                    : "text-amber-400",
                                )}
                              >
                                Agent may be stuck
                              </span>
                              <span className="text-white/50 ml-1">
                                : no activity for{" "}
                                {Math.floor(viewingMissionStallSeconds)}s
                              </span>
                              <p className="text-white/40 text-xs mt-1">
                                {isViewingMissionSeverelyStalled
                                  ? "The agent appears to be stuck on a long-running operation. Consider stopping it."
                                  : "A tool or external operation may be taking longer than expected."}
                              </p>
                            </div>
                          </div>
                          <button
                            onClick={() =>
                              handleCancelMission(viewingMissionId)
                            }
                            className={cn(
                              "shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                              isViewingMissionSeverelyStalled
                                ? "bg-red-500 text-white hover:bg-red-400"
                                : "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 border border-amber-500/30",
                            )}
                          >
                            <Square className="h-3.5 w-3.5" />
                            {isViewingMissionSeverelyStalled
                              ? "Force Stop"
                              : "Stop"}
                          </button>
                        </div>
                      </div>
                    )}

                  {/* Continue banner for blocked missions */}
                  {activeMission?.status === "blocked" && items.length > 0 && (
                    <div className="flex justify-center py-4">
                      <div className="flex items-center gap-3 rounded-xl bg-amber-500/10 border border-amber-500/20 px-5 py-3">
                        <Clock className="h-5 w-5 text-amber-400" />
                        <div className="text-sm">
                          <span className="text-amber-400 font-medium">
                            Iteration limit reached
                          </span>
                          <span className="text-white/50 ml-1">
                            : agent used all {maxIterations} iterations
                          </span>
                        </div>
                        <button
                          onClick={() => handleResumeMission()}
                          disabled={missionLoading}
                          className="ml-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-black hover:bg-amber-400 transition-colors disabled:opacity-50"
                        >
                          {missionLoading ? (
                            <Loader className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <PlayCircle className="h-3.5 w-3.5" />
                          )}
                          Continue
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              </>)}
            </div>

            {/* Scroll to bottom button */}
            {!isAtBottom && items.length > 0 && (
              <button
                onClick={() => scrollToBottom()}
                className="absolute bottom-20 right-6 p-2 rounded-full bg-white/[0.1] border border-white/[0.1] text-white/60 hover:bg-white/[0.15] hover:text-white/80 transition-all shadow-lg"
                title="Scroll to bottom"
              >
                <ArrowDown className="h-4 w-4" />
              </button>
            )}

            {/* Input */}
            <div className="border-t border-white/[0.06] bg-white/[0.01] p-4">
              {/* Upload progress */}
              {uploadProgress && (
                <div className="mx-auto w-full max-w-4xl xl:max-w-5xl mb-3">
                  <div className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <Loader className="h-4 w-4 animate-spin text-indigo-400" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="text-white/70 truncate">
                          {uploadProgress.fileName}
                        </span>
                        <span className="text-white/50 ml-2 shrink-0">
                          {formatBytes(uploadProgress.progress.loaded)} /{" "}
                          {formatBytes(uploadProgress.progress.total)}
                        </span>
                      </div>
                      <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                          style={{
                            width: `${uploadProgress.progress.percentage}%`,
                          }}
                        />
                      </div>
                    </div>
                    <span className="text-sm text-white/50 shrink-0">
                      {uploadProgress.progress.percentage}%
                    </span>
                  </div>
                </div>
              )}

              {/* Upload queue (for files waiting) */}
              {uploadQueue.length > 0 && !uploadProgress && (
                <div className="mx-auto w-full max-w-4xl xl:max-w-5xl mb-3 flex flex-wrap gap-2">
                  {uploadQueue.map((name) => (
                    <AttachmentPreview
                      key={name}
                      file={{ name, type: "" }}
                      isUploading
                    />
                  ))}
                </div>
              )}

              {/* Show resume buttons for interrupted/blocked missions, otherwise show normal input */}
              {/* Both are always rendered to prevent unmounting the input (which loses typed text) */}
              {showResumeUI && (
                <div className="mx-auto flex max-w-3xl gap-3 items-center justify-center py-2">
                  <div className="flex items-center gap-2 text-sm text-white/50 mr-4">
                    <AlertTriangle className="h-4 w-4 text-amber-400" />
                    <span>
                      Mission{" "}
                      {activeMission.status === "blocked"
                        ? "blocked"
                        : activeMission.status === "failed"
                          ? "failed"
                          : "interrupted"}
                    </span>
                  </div>
                  <button
                    onClick={() => handleResumeMission()}
                    disabled={missionLoading}
                    className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] px-5 py-3 text-sm font-medium text-white/70 transition-colors disabled:opacity-50"
                  >
                    <PlayCircle className="h-4 w-4" />
                    {activeMission.status === "blocked"
                      ? "Continue"
                      : activeMission.status === "failed"
                        ? "Retry"
                        : "Resume"}
                  </button>
                  <button
                    onClick={() => setDismissedResumeUI(true)}
                    className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] px-5 py-3 text-sm font-medium text-white/70 transition-colors"
                  >
                    <MessageSquare className="h-4 w-4" />
                    Custom Message
                  </button>
                </div>
              )}
              <div
                className={cn(
                  "mx-auto w-full max-w-4xl xl:max-w-5xl w-full space-y-2",
                  showResumeUI && "hidden",
                )}
              >
                {/* Queue Strip - shows queued messages when present */}
                <QueueStrip
                  items={queuedItems}
                  onRemove={handleRemoveFromQueue}
                  onClearAll={handleClearQueue}
                />

                {activeSubagentTab ? (
                  <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5 text-xs text-amber-200/80">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      Background sub-agents are single-shot — input disabled.
                      Switch to <strong>Main thread</strong> to send a message.
                    </span>
                  </div>
                ) : (
                <form
                  onSubmit={(e) => e.preventDefault()}
                  className="relative"
                >
                  {/* Goal-mode pill — shown above the composer while a codex
                      `/goal` continuation loop is active. */}
                  {(() => {
                    const activeMissionId =
                      viewingMission?.id ?? currentMission?.id;
                    const goal = activeMissionId
                      ? goalInfoByMission[activeMissionId]
                      : undefined;
                    if (!goal) return null;
                    const statusLabel =
                      goal.status === "active"
                        ? `iter ${goal.iteration}`
                        : goal.status === "paused"
                          ? "paused"
                          : goal.status;
                    return (
                      <div
                        className="absolute -top-9 left-2 right-2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-200 max-w-fit"
                        title={goal.objective}
                      >
                        <span className="font-semibold">Goal</span>
                        <span className="text-indigo-300/60">·</span>
                        <span>{statusLabel}</span>
                        {goal.objective && (
                          <>
                            <span className="text-indigo-300/60">·</span>
                            <span className="truncate max-w-[40ch] text-indigo-200/70">
                              {goal.objective}
                            </span>
                          </>
                        )}
                      </div>
                    );
                  })()}

                  {/* Unified composer: textarea on top, action buttons
                      tucked inside the same rounded container at the
                      bottom. Mimics ChatGPT / Anthropic console — saves
                      horizontal real estate on mobile (~30% width) and
                      keeps the buttons within thumb reach. */}
                  <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] focus-within:border-indigo-500/40 transition-colors">
                    <div className="px-3 pt-2 pb-1">
                      <EnhancedInput
                        ref={enhancedInputRef}
                        value={input}
                        onChange={setInput}
                        onSubmit={handleEnhancedSubmit}
                        onCanSubmitChange={setCanSubmitInput}
                        onFilePaste={handleFilePaste}
                        placeholder="Message the root agent… (paste files to upload)"
                        backend={viewingMission?.backend ?? currentMission?.backend}
                        // Strip EnhancedInput's own border + bg — the
                        // outer wrapper supplies them now. Keep
                        // padding tight so the textarea doesn't have
                        // double-padding inside our container.
                        className="!border-0 !bg-transparent !px-0 !py-0"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="p-2 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors"
                        title="Attach files"
                        aria-label="Attach files"
                      >
                        <Paperclip className="h-5 w-5" />
                      </button>

                      {isBusy ? (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              enhancedInputRef.current?.submit()
                            }
                            disabled={!canSubmitComposer}
                            className="flex items-center gap-1.5 rounded-lg bg-indigo-500/80 hover:bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Queue message until the current turn ends"
                          >
                            <ListPlus className="h-4 w-4" />
                            <span className="hidden sm:inline">Queue</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleStop}
                            className="flex items-center gap-1.5 rounded-lg bg-red-500 hover:bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors"
                            title="Stop the current turn"
                          >
                            <Square className="h-4 w-4" />
                            <span className="hidden sm:inline">Stop</span>
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => enhancedInputRef.current?.submit()}
                          disabled={!canSubmitComposer}
                          className="flex items-center gap-1.5 rounded-lg bg-indigo-500 hover:bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-indigo-500"
                          title="Send (Enter)"
                          aria-label="Send"
                        >
                          <Send className="h-4 w-4" />
                          <span className="hidden sm:inline">Send</span>
                        </button>
                      )}
                    </div>
                  </div>
                </form>
                )}
              </div>
            </div>
          </div>

          {/* Right column: Workbench, Desktop Stream, Workers,
              Sub-agents, Agent Tasks stacked. Renders when ANY
              child panel wants to be visible — each child has its
              own dismiss state so closing one collapses just that
              panel; closing the LAST visible child collapses the
              whole column. Changes lives in a full-screen modal,
              not this column. */}
          {(showWorkbenchPanel ||
            showDesktopStream ||
            (showSubagentsPanel && hasInMissionSubagents) ||
            (showAgentTasksPanel &&
              latestAgentTodos &&
              latestAgentTodos.length > 0)) && (
            <div
              className={cn(
                // animate-fade-in is opacity-only and cheap; we drop the
                // `transition-all duration-300` that was animating width on
                // mount (the width change is what caused the chat-side reflow
                // freeze when toggling the Workers panel).
                // On phones: full-width and stacks below the chat.
                // On md+: fixed 320px sidecar (or wider for desktop stream).
                "min-h-0 flex flex-col gap-2 md:gap-4 animate-fade-in md:shrink-0",
                showDesktopStream
                  ? "w-full md:flex-1 md:max-w-md"
                  : "w-full md:w-80",
              )}
            >
              {showWorkbenchPanel && (
                <MissionWorkbenchPanel
                  key={`workbench-${activeMission?.id ?? "none"}`}
                  mission={activeMission}
                  workspaceLabel={activeWorkspaceLabel}
                  role={activeMissionRole}
                  isRunning={viewingMissionIsRunning}
                  onClose={() => setShowWorkbenchPanel(false)}
                  onResume={handleResumeMission}
                  onCancel={handleCancelMission}
                  onOpenAutomations={() => setShowAutomationsDialog(true)}
                  onOpenSwitcher={() => setShowMissionSwitcher(true)}
                  onViewMission={handleViewMission}
                  onSetStatus={handleSetStatus}
                  dockerServices={
                    activeMission
                      ? dockerServicesByMission[activeMission.id]
                      : undefined
                  }
                  usage={missionUsage}
                  runSettingsSlot={
                    activeMission && !viewingMissionIsRunning ? (
                      <NewMissionDialog
                        workspaces={workspaces}
                        disabled={missionLoading}
                        onCreate={handleUpdateMissionSettings}
                        mode="edit"
                        lockWorkspace
                        initialValues={{
                          workspaceId: activeMission.workspace_id,
                          agent: activeMission.agent || undefined,
                          backend: activeMission.backend,
                          modelOverride:
                            activeMission.model_override || undefined,
                          modelEffort: activeMission.model_effort || undefined,
                          configProfile: activeMission.config_profile,
                        }}
                      />
                    ) : undefined
                  }
                  className="flex-1 min-h-0"
                />
              )}

              {/* Sub-agents Panel — Claude Code's in-process Task /
                  spawn_agent / workflow-runtime subagents. Per-mission
                  dismiss tracking via `subagentsPanelDismissedRef` so
                  re-opening the same mission respects an explicit
                  close. */}
              {showSubagentsPanel && hasInMissionSubagents && (
                <SubagentsPanel
                  subagents={inMissionSubagents}
                  onFocusItem={focusChatItem}
                  onClose={handleCloseSubagentsPanel}
                  className={cn(
                    showWorkbenchPanel || showDesktopStream
                      ? "flex-1 min-h-0"
                      : "flex-1",
                  )}
                />
              )}

              {/* Agent Tasks panel — TodoWrite snapshot as its own
                  sidebar (was previously inlined inside the
                  workbench card). Has its own dismiss state +
                  close button. */}
              {showAgentTasksPanel &&
                latestAgentTodos &&
                latestAgentTodos.length > 0 && (
                  <AgentTasksPanel
                    todos={latestAgentTodos}
                    onClose={handleCloseAgentTasksPanel}
                    className={cn(
                      showWorkbenchPanel ||
                        showDesktopStream ||
                        (showSubagentsPanel && hasInMissionSubagents)
                        ? "flex-1 min-h-0"
                        : "flex-1",
                    )}
                  />
                )}

              {/* (Thinking Panel removed — thoughts now render
                  inline in the main chat thread.) */}

              {/* Desktop Stream Panel */}
              {showDesktopStream && (
                <div className="min-h-0 flex-1">
                  <DesktopStream
                    displayId={desktopDisplayId}
                    className="h-full"
                    onClose={() => setShowDesktopStream(false)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
        </MissionScope>
      </div>
    </NowTickProvider>
  );
}
