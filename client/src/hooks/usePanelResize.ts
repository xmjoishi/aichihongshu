import { useState, useRef, useCallback } from "react";

interface Options {
  defaultWidth?: number;
  min?: number;
  max?: number;
  /** 拖拽方向：向左拖宽（right panel）或向右拖宽（left panel）。默认 "left"（右侧面板向左拖时变宽） */
  direction?: "left" | "right";
  storageKey?: string;
}

function readStorage(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    if (v) return Number(v);
  } catch {}
  return fallback;
}

/**
 * 通用面板宽度拖拽 Hook。
 * 返回 { width, onDragStart, DragHandle }
 *
 * DragHandle 是一个 JSX 元素，直接放到面板内即可。
 */
export function usePanelResize({
  defaultWidth = 320,
  min = 240,
  max = 700,
  direction = "left",
  storageKey,
}: Options = {}) {
  const [width, setWidth] = useState<number>(() =>
    storageKey ? readStorage(storageKey, defaultWidth) : defaultWidth
  );
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startW: width };
      setDragging(true);

      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta =
          direction === "left"
            ? dragRef.current.startX - ev.clientX
            : ev.clientX - dragRef.current.startX;
        const next = Math.min(max, Math.max(min, dragRef.current.startW + delta));
        setWidth(next);
        if (storageKey) {
          try { localStorage.setItem(storageKey, String(next)); } catch {}
        }
      };

      const onUp = () => {
        dragRef.current = null;
        setDragging(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, direction, min, max, storageKey]
  );

  return { width, dragging, onDragStart };
}
