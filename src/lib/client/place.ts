/**
 * Where to put a small card (tour step, glossary popover) next to its anchor: below it when it fits, above it when
 * not, otherwise pinned to the bottom edge; always inside the viewport. Pure, so it is tested in node.
 */
export interface Rect { top: number; left: number; bottom: number; right: number }

export function placeNear(
  anchor: Rect,
  card: { w: number; h: number },
  view: { w: number; h: number },
  gap = 8,
): { top: number; left: number; side: 'below' | 'above' | 'edge' } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const left = clamp(anchor.left, gap, view.w - card.w - gap);
  if (anchor.bottom + gap + card.h <= view.h - gap) return { top: anchor.bottom + gap, left, side: 'below' };
  if (anchor.top - gap - card.h >= gap) return { top: anchor.top - gap - card.h, left, side: 'above' };
  return { top: clamp(view.h - card.h - gap, gap, view.h), left, side: 'edge' };
}
