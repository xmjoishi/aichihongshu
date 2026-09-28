import { useEffect, useRef, type RefObject } from "react";

const ignoredScrollEvents = new WeakMap<HTMLElement, number>();

/** Save one concrete scroll container and restore it after its content is ready. */
export function useSavedScrollPosition<T extends HTMLElement>(
  ref: RefObject<T | null>,
  storageKey: string,
  restoreReady = true,
): void {
  const restoringRef = useRef(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const save = () => {
      const restoredTop = ignoredScrollEvents.get(element);
      if (restoredTop !== undefined) {
        ignoredScrollEvents.delete(element);
        if (Math.abs(element.scrollTop - restoredTop) < 1) return;
      }
      try { sessionStorage.setItem(storageKey, String(element.scrollTop)); } catch { /* optional */ }
    };

    element.addEventListener("scroll", save, { passive: true });
    return () => {
      // A route can unmount before the browser dispatches its final scroll event.
      // Preserve the current position, but never replace an unfinished restore target.
      if (!restoringRef.current) {
        try { sessionStorage.setItem(storageKey, String(element.scrollTop)); } catch { /* optional */ }
      }
      element.removeEventListener("scroll", save);
    };
  // restoreReady may coincide with the real scroll node appearing after a
  // loading placeholder, or with a tab swapping out and remounting that node.
  }, [ref, restoreReady, storageKey]);

  useEffect(() => {
    const element = ref.current;
    if (!restoreReady || !element) return;

    let saved = 0;
    try { saved = Number(sessionStorage.getItem(storageKey)); } catch { return; }
    if (!Number.isFinite(saved) || saved <= 0) return;
    restoringRef.current = true;

    let finished = false;
    let interval = 0;
    let timeout = 0;

    const stop = () => {
      if (interval) window.clearInterval(interval);
      if (timeout) window.clearTimeout(timeout);
      interval = 0;
      timeout = 0;
    };

    const cancel = () => {
      finished = true;
      restoringRef.current = false;
      stop();
    };

    const restore = () => {
      if (finished) return;
      if (element.scrollTop < saved) {
        const previousTop = element.scrollTop;
        element.scrollTop = saved;
        if (element.scrollTop === previousTop) ignoredScrollEvents.delete(element);
        else ignoredScrollEvents.set(element, element.scrollTop);
      }
      if (element.scrollTop >= saved - 1) {
        finished = true;
        restoringRef.current = false;
        stop();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) cancel();
    };

    element.addEventListener("wheel", cancel, { passive: true });
    element.addEventListener("touchstart", cancel, { passive: true });
    element.addEventListener("pointerdown", cancel, { passive: true });
    element.addEventListener("keydown", onKeyDown);
    interval = window.setInterval(restore, 120);
    timeout = window.setTimeout(stop, 12_000);
    restore();

    return () => {
      cancel();
      element.removeEventListener("wheel", cancel);
      element.removeEventListener("touchstart", cancel);
      element.removeEventListener("pointerdown", cancel);
      element.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, restoreReady, storageKey]);
}
