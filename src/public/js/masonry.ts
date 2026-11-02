// Masonry layout: each item goes into the shortest column (leftmost on a tie), so a
// newest-first list reads left to right across the top row. Tiles are sized from the stored
// width/height before any image loads, so nothing reflows as thumbnails arrive.

const GAP = 12;
const MIN_COL = 240;
const MAX_RATIO = 2.6;  // cap very tall images at this height/width; the thumb is object-fit: cover

export function columnsFor(width: number): number {
  if (width < 560) return 2;
  return Math.max(2, Math.floor((width + GAP) / (MIN_COL + GAP)));
}

export interface Slot { x: number; y: number; w: number; h: number }

// Computes a slot for every item (just arithmetic, so cheap for thousands of pins) and sets the
// container's height; the caller places only the tiles it mounts (see place). Returns null while
// the container has no width yet. Each item goes in the lowest column, so slots' y never
// decreases down the list.
export function layout(container: HTMLElement, items: { width: number; height: number }[]): { colW: number; slots: Slot[] } | null {
  const width = container.clientWidth;
  if (!width) return null;
  const cols = columnsFor(width);
  const colW = (width - GAP * (cols - 1)) / cols;
  const heights: number[] = new Array(cols).fill(0);

  const slots = items.map((item) => {
    const ratio = Math.min(MAX_RATIO, item.height / item.width || 1);
    const h = Math.round(colW * ratio);
    let c = 0;
    for (let i = 1; i < cols; i++) if (heights[i] < heights[c]) c = i;
    const slot = { x: Math.round(c * (colW + GAP)), y: Math.round(heights[c]), w: colW, h };
    heights[c] += h + GAP;
    return slot;
  });
  container.style.height = `${Math.max(0, Math.max(...heights) - GAP)}px`;
  return { colW, slots };
}

export function place(el: HTMLElement, slot: Slot) {
  const s = el.style;
  s.transform = `translate(${slot.x}px, ${slot.y}px)`;
  s.width = `${slot.w}px`;
  s.height = `${slot.h}px`;
}
