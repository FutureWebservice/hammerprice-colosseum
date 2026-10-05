/**
 * The hero room's scroll-length rules. A plain module (no 'use client') so the server-rendered landing
 * page can call these; ScrollRoom.tsx is a client component, and a server component cannot call a
 * function it imports from one.
 */

/** The pinned scroll of the hero, in viewport heights: how far the visitor scrolls while the stage
 *  stays put. Phones get much more than desktops: a swipe is short and carries momentum, so the same
 *  distance that suits a mouse wheel runs the whole sequence in one flick. */
export const HERO_PINNED_VIEWPORTS = { desktop: 4.5, mobile: 6 } as const;

/** Height of the room (the tall spacer), in vh, for a pinned scroll of `pinnedViewports` viewport
 *  heights: the sticky stage itself takes one viewport of the spacer. Pure + testable. */
export function roomHeightVh(pinnedViewports: number): number {
  return Math.round((pinnedViewports + 1) * 100);
}

/** Pixels of scroll per sequence frame for a viewport of `viewportPx` height. Pure + testable. */
export function scrollPxPerFrame(viewportPx: number, pinnedViewports: number, frameCount: number): number {
  return (viewportPx * pinnedViewports) / Math.max(1, frameCount - 1);
}
