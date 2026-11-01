// Masonry layout: each item goes into the shortest column (leftmost on a tie), so a
// newest-first list reads left to right across the top row. Tiles are sized from the stored
// width/height before any image loads, so nothing reflows as thumbnails arrive.

const GAP = 12;
const MIN_COL = 240;
const MAX_RATIO = 2.6;  // cap very tall images at this height/width; the thumb is object-fit: cover

export function columnsFor(width) {
  if (width < 560) return 2;
  return Math.max(2, Math.floor((width + GAP) / (MIN_COL + GAP)));
}

// items: [{ el, width, height }]. Positions the elements absolutely and sets the container height.
export function layout(container, items) {
  const width = container.clientWidth;
  if (!width) return null;
  const cols = columnsFor(width);
  const colW = (width - GAP * (cols - 1)) / cols;
  const heights = new Array(cols).fill(0);

  for (const item of items) {
    const ratio = Math.min(MAX_RATIO, item.height / item.width || 1);
    const h = Math.round(colW * ratio);
    let c = 0;
    for (let i = 1; i < cols; i++) if (heights[i] < heights[c]) c = i;
    const s = item.el.style;
    s.transform = `translate(${Math.round(c * (colW + GAP))}px, ${Math.round(heights[c])}px)`;
    s.width = `${colW}px`;
    s.height = `${h}px`;
    heights[c] += h + GAP;
  }
  container.style.height = `${Math.max(0, Math.max(...heights) - GAP)}px`;
  return colW;
}
