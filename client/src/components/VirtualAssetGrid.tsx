import { useRef, useState, type ReactNode, type RefObject } from "react";
import { useWorkspaceEffect } from "../lib/workspaceActivity";

/** Fixed image + bounded caption rows keep full scroll geometry with a small DOM. */
export default function VirtualAssetGrid<T>({ items, columns, scrollRef, children }: {
  items: T[];
  columns: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  children: (item: T) => ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 800, top: 0, height: 800, narrow: false });
  useWorkspaceEffect(() => {
    const root = rootRef.current;
    const scroller = scrollRef.current;
    if (!root || !scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const width = root.clientWidth;
      if (!width) return;
      const top = Math.max(0, scroller.getBoundingClientRect().top - root.getBoundingClientRect().top);
      const height = scroller.clientHeight;
      const narrow = window.matchMedia("(max-width: 1100px)").matches;
      setViewport((old) => old.width === width && old.top === top && old.height === height && old.narrow === narrow
        ? old : { width, top, height, narrow });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    observer.observe(scroller);
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [scrollRef]);
  const count = viewport.narrow ? Math.max(1, Math.floor((viewport.width + 16) / 156)) : columns;
  const rowHeight = (viewport.width - (count - 1) * 16) / count + 70;
  const stride = rowHeight + 16;
  const rows = Math.ceil(items.length / count);
  const start = Math.min(Math.max(0, rows - 1), Math.max(0, Math.floor(viewport.top / stride) - 2));
  const end = Math.min(rows, Math.ceil((viewport.top + viewport.height) / stride) + 2);
  return (
    <div ref={rootRef} className="relative w-full" style={{ height: Math.max(0, rows * stride - 16) }}>
      <div className="absolute inset-x-0 grid gap-4" style={{
        top: start * stride,
        gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
        gridAutoRows: rowHeight,
      }}>
        {items.slice(start * count, end * count).map(children)}
      </div>
    </div>
  );
}
