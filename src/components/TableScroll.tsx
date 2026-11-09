import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * `.table-scroll` plus a second horizontal scrollbar above the table, kept in
 * sync with the browser's own one below it, so a wide table can be scrolled
 * sideways without first going all the way down to its last row. The top bar
 * only shows while the table actually overflows.
 */
export default function TableScroll({ children }: { children: ReactNode }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => {
      setContentWidth(scroller.scrollWidth);
      setOverflowing(scroller.scrollWidth > scroller.clientWidth + 1);
    };
    measure();
    // The container (window, assistant panel) and the table (rows, visible
    // columns) can each change the overflow on their own.
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, []);

  // Setting the value it already has fires no event, so the two can't loop.
  function syncFrom(source: HTMLDivElement | null, target: HTMLDivElement | null) {
    if (source && target) target.scrollLeft = source.scrollLeft;
  }

  return (
    <>
      <div
        ref={topBarRef}
        className="table-top-scroll"
        hidden={!overflowing}
        aria-hidden="true"
        onScroll={() => syncFrom(topBarRef.current, scrollerRef.current)}
      >
        <div style={{ width: contentWidth, height: 1 }} />
      </div>
      <div ref={scrollerRef} className="table-scroll" onScroll={() => syncFrom(scrollerRef.current, topBarRef.current)}>
        {children}
      </div>
    </>
  );
}
