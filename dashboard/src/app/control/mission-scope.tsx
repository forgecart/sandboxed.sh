"use client";

import type { ReactNode } from "react";

/**
 * Mission-scoped subtree boundary.
 *
 * ControlClient previously held every mission-bound hook (items
 * reducer, SSE/WS connections, buffer-flush timers, virtualizer,
 * composer, Monaco model bindings, subagent state, …) in the same
 * component instance as the mission-agnostic shell (tab bar,
 * mission list, navigation). On mission switch, `viewingMissionId`
 * flipped but the instance stayed — refs / timers / EventSources /
 * Monaco editors carried through, producing stale-event leakage
 * and a recurring `Cannot read properties of null (reading
 * 'removeChild')` loop in React's commit phase.
 *
 * `MissionScope` is the keyed boundary: `<MissionScope
 * key={missionId} missionId={missionId}>`. When `missionId`
 * changes the entire MissionScope instance unmounts — every
 * useEffect cleanup fires, every ref dies with its closure,
 * every AbortController.abort() / EventSource.close() /
 * editor.dispose() runs — then a fresh instance mounts for the
 * new mission. No state aliasing, no event leakage across
 * missions.
 *
 * Phase 0 (this commit): structural pass-through only. The
 * subtree of JSX previously sitting under `<MissionTabBar />`
 * now renders as `MissionScope`'s children. No hooks have moved
 * into MissionScope yet; that happens incrementally in Phases
 * 1-7 (see /Users/daghangunay/.claude/plans/ok-now-i-want-witty-raccoon.md).
 */
interface MissionScopeProps {
  /**
   * The currently-viewing mission's id. Used as the parent
   * component's `key` to force unmount/remount on switch — this
   * prop is here so the type is documented even though Phase 0
   * doesn't yet read it; subsequent phases will pass it into
   * mission-bound effects.
   */
  missionId: string | null;
  children: ReactNode;
}

export function MissionScope({ children }: MissionScopeProps) {
  return <>{children}</>;
}
