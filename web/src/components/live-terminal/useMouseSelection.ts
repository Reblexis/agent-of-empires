import { useCallback, useEffect, useRef, type RefObject } from "react";
import { writeClipboard } from "../../lib/clipboard";

/** A desktop drag-select over the rendered text: the follow pin waits like under a touch, so streamed frames do not
 *  scroll the text under the pointer, and releasing the drag copies a selection made inside the terminal. */
export function useMouseSelection({
  scrollerRef,
  forwardModeRef,
  touchActiveRef,
}: {
  scrollerRef: RefObject<HTMLElement | null>;
  /** A full-screen mouse app gets the press instead; there is no text selection to protect. */
  forwardModeRef: RefObject<boolean>;
  touchActiveRef: RefObject<boolean>;
}) {
  const selectingRef = useRef(false);
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0 || forwardModeRef.current) return;
      selectingRef.current = true;
      touchActiveRef.current = true;
    },
    [forwardModeRef, touchActiveRef],
  );
  // On window: a drag routinely ends outside the scroller.
  useEffect(() => {
    const finish = (e: PointerEvent) => {
      if (!selectingRef.current) return;
      selectingRef.current = false;
      touchActiveRef.current = false;
      if (e.type !== "pointerup") return;
      // The pointerup grants the transient activation the clipboard write needs.
      const sel = window.getSelection();
      const el = scrollerRef.current;
      if (!sel || sel.isCollapsed || !el || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
      const text = sel.toString();
      if (text) void writeClipboard(text);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [scrollerRef, touchActiveRef]);
  return { onPointerDown };
}
