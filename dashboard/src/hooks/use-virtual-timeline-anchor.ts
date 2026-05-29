"use client";

import type { Virtualizer } from "@tanstack/react-virtual";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type UseVirtualTimelineAnchorArgs<TScrollElement extends HTMLElement> = {
  scrollElementRef: RefObject<TScrollElement | null>;
  virtualizer: Virtualizer<TScrollElement, Element>;
  itemCount: number;
  changeKey: string;
  resetKey?: string | null;
  bottomThreshold?: number;
};

export function useVirtualTimelineAnchor<TScrollElement extends HTMLElement>({
  scrollElementRef,
  virtualizer,
  itemCount,
  changeKey,
  resetKey,
  bottomThreshold = 96,
}: UseVirtualTimelineAnchorArgs<TScrollElement>) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  // Timestamp (ms) until which scroll events are ignored for the
  // purposes of `isAtBottomRef` bookkeeping. `scrollToBottom` sets
  // this so that the intermediate scroll events fired during an
  // animated scroll-to-end don't flip `isAtBottomRef` to `false`
  // mid-animation — that race used to make the subsequent layout
  // effect (which is what actually issues the scroll to the new
  // last item after a `setItems` commit) skip its work because
  // it'd see the ref as `false`. Window only needs to cover the
  // animation; 600 ms is enough for a smooth scroll across the
  // viewport even on long lists.
  const anchorLockUntilRef = useRef(0);

  const cancelPendingScroll = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const scheduleBottomCorrection = useCallback(
    (targetIndex: number, behavior?: ScrollBehavior) => {
      cancelPendingScroll();
      rafRef.current = requestAnimationFrame(() => {
        virtualizer.scrollToIndex(targetIndex, {
          align: "end",
          behavior,
        });
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          virtualizer.scrollToIndex(targetIndex, {
            align: "end",
            behavior,
          });
          const el = scrollElementRef.current;
          if (el) {
            el.scrollTop = el.scrollHeight;
          }
        });
      });
    },
    [cancelPendingScroll, scrollElementRef, virtualizer],
  );

  const updateAnchorFromScroll = useCallback(() => {
    const el = scrollElementRef.current;
    if (!el) return;
    if (Date.now() < anchorLockUntilRef.current) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom <= bottomThreshold;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, [bottomThreshold, scrollElementRef]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (itemCount <= 0) return;
      isAtBottomRef.current = true;
      setIsAtBottom(true);
      anchorLockUntilRef.current = Date.now() + 600;
      virtualizer.scrollToIndex(itemCount - 1, {
        align: "end",
        behavior,
      });
      scheduleBottomCorrection(itemCount - 1, behavior);
    },
    [itemCount, scheduleBottomCorrection, virtualizer],
  );

  useEffect(() => {
    const el = scrollElementRef.current;
    if (!el) return;
    updateAnchorFromScroll();
    el.addEventListener("scroll", updateAnchorFromScroll, { passive: true });
    return () => el.removeEventListener("scroll", updateAnchorFromScroll);
  }, [scrollElementRef, updateAnchorFromScroll]);

  useEffect(() => {
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    if (itemCount > 0) {
      scheduleBottomCorrection(itemCount - 1, "instant");
    }
    return cancelPendingScroll;
    // Reset only when the timeline identity changes; ordinary item changes
    // are handled by the anchor-preserving layout effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useLayoutEffect(() => {
    if (!isAtBottomRef.current) {
      return;
    }
    if (itemCount <= 0) return;
    scheduleBottomCorrection(itemCount - 1);

    return cancelPendingScroll;
  }, [cancelPendingScroll, changeKey, itemCount, scheduleBottomCorrection]);

  return {
    isAtBottom,
    scrollToBottom,
  };
}
