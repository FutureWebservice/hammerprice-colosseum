'use client';

/**
 * Draws a pre-rendered frame sequence (public/generated/<id>/manifest.json) to a canvas,
 * scrubbed by an external scroll-progress ref rather than React state - a rAF-driven progress
 * update at 60fps as component state would re-render this on every tick; a ref lets ScrollRoom
 * write progress every scroll event and this component read it once per animation frame.
 *
 * Three rules keep this from stuttering (see the room's brief):
 *   1. Frames are loaded/decoded ahead of the playhead, not fetched at scroll time. The sequence is long
 *      (150 desktop / 90 phone frames), so it is not all fetched at once: from the first scroll or touch (or 8 s after load), a window
 *      around the playhead plus a sparse skeleton (every SKELETON_STRIDE-th frame) is loaded, the window
 *      following the scroll, and frames far behind the playhead are dropped again (decoded frames are big).
 *   2. The canvas is never cleared to blank - if the exact target frame isn't decoded yet, the
 *      nearest already-decoded neighbour (or the last frame drawn) stays on screen.
 *   3. Drawing happens once per rAF tick, not once per scroll event, and only when the target frame changed (or a frame just arrived):
 *      an idle tick does no work. Decoded frames are kept as ImageBitmaps where the browser has them (no decode at draw time), and a
 *      weak device (4 cores or fewer, or 4 GB or less) paints at a backing size of at most 1.5 x the CSS size instead of 2 x.
 */
import { useEffect, useRef, useState } from 'react';

export interface FrameManifest {
  frameCount: number;
  frameUrlTemplate: string; // contains a literal "%04d" placeholder, 1-indexed
  poster: string;
  size: { width: number; height: number };
}

const MOBILE_BREAKPOINT = 768;
const MAX_DPR = 2;
const MAX_DPR_LOW_END = 1.5;
const PRELOAD_CONCURRENCY = 4;
const NEIGHBOUR_SEARCH = 8; // frames to look back (then forward) for a decoded stand-in
export const LOAD_AHEAD = 36; // frames in front of the playhead that are fetched
export const LOAD_BEHIND = 8; // and behind it (scrolling back a little)
export const KEEP_AHEAD = 48; // frames outside [target - KEEP_BEHIND, target + KEEP_AHEAD] are released
export const KEEP_BEHIND = 16;
export const SKELETON_STRIDE = 6; // one frame in six is always kept: a stand-in is never more than 3 away (< NEIGHBOUR_SEARCH)
const START_FALLBACK_MS = 8000; // loading starts at the first scroll/touch/key, or this long after the page's load

/** Scroll progress (0..1) -> the nearest frame index, clamped to the sequence. Pure + testable. */
export function frameIndexForProgress(progress: number, frameCount: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return Math.round(p * (frameCount - 1));
}

/** frame-%04d.jpg style template -> the real URL for a 0-based frame index. */
export function frameUrl(template: string, index: number): string {
  return template.replace('%04d', String(index + 1).padStart(4, '0'));
}

/** The nearest ready (decoded) frame at or before `target`, else the nearest just after it,
 *  else -1 (caller keeps whatever is already on screen). Pure + testable. */
export function nearestReadyFrame(target: number, ready: boolean[], window = NEIGHBOUR_SEARCH): number {
  for (let i = target; i >= Math.max(0, target - window); i--) if (ready[i]) return i;
  for (let i = target + 1; i < Math.min(ready.length, target + window); i++) if (ready[i]) return i;
  return -1;
}

/** The next frame to fetch, or -1 when nothing is left to do right now. Order: the playhead and the
 *  frames just ahead of it (a little behind, too), then the skeleton, nearest to the playhead first.
 *  `requested[i]` is true once a frame was fetched (or is being fetched, or failed). Pure + testable. */
export function nextFrameToLoad(target: number, requested: boolean[]): number {
  const n = requested.length;
  for (let d = 0; d <= LOAD_AHEAD; d++) {
    const f = target + d;
    if (f < n && !requested[f]) return f;
    const b = target - d;
    if (d > 0 && d <= LOAD_BEHIND && b >= 0 && !requested[b]) return b;
  }
  for (let d = 0; d < n; d++) {
    for (const f of [target + d, target - d]) {
      if (f >= 0 && f < n && f % SKELETON_STRIDE === 0 && !requested[f]) return f;
    }
  }
  return -1;
}

/** Whether a frame may stay in memory while the playhead is at `target`. Pure + testable. */
export function shouldKeepFrame(index: number, target: number): boolean {
  return index % SKELETON_STRIDE === 0 || (index >= target - KEEP_BEHIND && index <= target + KEEP_AHEAD);
}

/** The most device pixels per CSS pixel the canvas is painted at: 2, or 1.5 on a weak device (few cores or little memory). Pure + testable. */
export function maxDpr(nav: { hardwareConcurrency?: number; deviceMemory?: number }): number {
  const weak = (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
  return weak ? MAX_DPR_LOW_END : MAX_DPR;
}

type FrameSource = HTMLImageElement | ImageBitmap;
const sizeOf = (f: FrameSource) => (f instanceof HTMLImageElement ? { w: f.naturalWidth, h: f.naturalHeight } : { w: f.width, h: f.height });

function drawCover(canvas: HTMLCanvasElement, img: FrameSource, dprCap: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (!cssW || !cssH) return;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { w: iw, h: ih } = sizeOf(img);
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

export default function CanvasSequence({
  desktop,
  mobile,
  progressRef,
}: {
  desktop: FrameManifest | null;
  mobile: FrameManifest | null;
  progressRef: React.RefObject<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [manifest, setManifest] = useState<FrameManifest | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const imagesRef = useRef<(FrameSource | undefined)[]>([]);
  const dprCap = useRef(MAX_DPR);
  const dirtyRef = useRef(true); // a frame arrived, the loading started or the size changed: the next tick must look again
  const readyRef = useRef<boolean[]>([]);
  const lastDrawnRef = useRef(-1);

  // Pick the manifest for the current viewport, and re-pick if it crosses the breakpoint.
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const pick = () => setManifest((mq.matches ? mobile : desktop) ?? desktop ?? mobile ?? null);
    pick();
    mq.addEventListener('change', pick);
    return () => mq.removeEventListener('change', pick);
  }, [desktop, mobile]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const set = () => setReducedMotion(mq.matches);
    set();
    mq.addEventListener('change', set);
    return () => mq.removeEventListener('change', set);
  }, []);

  // No poster is drawn here any more: the canvas starts transparent over the server-rendered first frame (ScrollRoom's
  // <picture>, the same image the scrub shows at progress 0), so nothing flashes while the frames decode.

  // Load frames around the playhead (see the header), with limited concurrency. reduced-motion skips
  // this entirely: that build never scrubs, so there is nothing to load. The returned `pump` is called
  // by the draw loop every animation frame: it starts fetches while a slot is free, and releases frames
  // that fell far behind.
  const pumpRef = useRef<() => void>(() => {});
  useEffect(() => {
    dprCap.current = maxDpr(navigator as Navigator & { deviceMemory?: number });
  }, []);
  useEffect(() => {
    if (!manifest || reducedMotion) return;
    let cancelled = false;
    let started = false;
    let active = 0;
    const count = manifest.frameCount;
    imagesRef.current = new Array(count);
    readyRef.current = new Array(count).fill(false);
    const requested: boolean[] = new Array(count).fill(false);
    lastDrawnRef.current = -1;

    const loadOne = (i: number) => {
      requested[i] = true;
      active++;
      const img = new Image();
      img.decoding = 'async';
      const done = (ok: boolean, bitmap?: ImageBitmap) => {
        active--;
        dirtyRef.current = true; // a slot is free (and maybe a new frame to paint): the next tick pumps again
        if (ok && !cancelled && requested[i]) {
          imagesRef.current[i] = bitmap ?? img;
          readyRef.current[i] = true;
        } else bitmap?.close();
      };
      img.onload = () => {
        // Decode before the frame counts as ready: the first drawImage of an undecoded image would
        // decode on the main thread, in the middle of a scroll. Where the browser has createImageBitmap the
        // frame is kept as a bitmap, which stays decoded (an image's decoded pixels can be evicted and decoded again at draw time).
        const dec = typeof img.decode === 'function' ? img.decode() : Promise.resolve();
        dec
          .then(() => (typeof createImageBitmap === 'function' ? createImageBitmap(img) : undefined))
          .then((bm) => done(true, bm), () => done(true));
      };
      // A missing/broken frame just never becomes ready (and is not retried); the draw loop falls
      // back to a neighbour or the last good frame, it never blocks the rest of the sequence.
      img.onerror = () => done(false);
      img.src = frameUrl(manifest.frameUrlTemplate, i);
    };

    pumpRef.current = () => {
      if (!started || cancelled) return;
      const target = frameIndexForProgress(progressRef.current ?? 0, count);
      while (active < PRELOAD_CONCURRENCY) {
        const i = nextFrameToLoad(target, requested);
        if (i === -1) break;
        loadOne(i);
      }
      // Release what the playhead left far behind; it is fetched again (from the HTTP cache) if
      // the visitor scrolls back. lastDrawn is never dropped.
      for (let i = 0; i < count; i++) {
        if (requested[i] && i !== lastDrawnRef.current && !shouldKeepFrame(i, target)) {
          requested[i] = false;
          readyRef.current[i] = false;
          const gone = imagesRef.current[i];
          if (gone && !(gone instanceof HTMLImageElement)) gone.close();
          imagesRef.current[i] = undefined;
        }
      }
    };

    // Not before the visitor does something (scroll, touch, wheel, key) or, failing that, a good while
    // after the page's load: the hero's first frame is a plain <img> in the HTML, and fetching a window of
    // frames must not compete with the load or sit in a page nobody scrolls. Frames arrive in well under
    // a swipe, and the first frame stays on screen until they do.
    const start = () => {
      started = true;
      dirtyRef.current = true;
    };
    let idleId = 0;
    const afterLoad = () => {
      idleId = window.setTimeout(start, START_FALLBACK_MS);
    };
    if (document.readyState === 'complete') afterLoad();
    else window.addEventListener('load', afterLoad, { once: true });
    const wake = ['scroll', 'wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    wake.forEach((e) => window.addEventListener(e, start, { once: true, passive: true }));
    return () => {
      cancelled = true;
      pumpRef.current = () => {};
      imagesRef.current.forEach((f) => f && !(f instanceof HTMLImageElement) && f.close());
      imagesRef.current = [];
      window.clearTimeout(idleId);
      window.removeEventListener('load', afterLoad);
      wake.forEach((e) => window.removeEventListener(e, start));
    };
  }, [manifest, reducedMotion, progressRef]);

  // The draw loop: once per animation frame, map the latest scroll progress to a frame and
  // paint it if it's new - never tied 1:1 to scroll events.
  useEffect(() => {
    if (!manifest || reducedMotion) return;
    let raf = 0;
    let lastTarget = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const target = frameIndexForProgress(progressRef.current ?? 0, manifest.frameCount);
      if (target === lastTarget && !dirtyRef.current) return; // nothing to load, nothing to paint
      lastTarget = target;
      dirtyRef.current = false;
      pumpRef.current();
      const canvas = canvasRef.current;
      const idx = nearestReadyFrame(target, readyRef.current);
      if (canvas && idx !== -1 && idx !== lastDrawnRef.current) {
        const img = imagesRef.current[idx];
        if (img) {
          drawCover(canvas, img, dprCap.current);
          lastDrawnRef.current = idx;
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [manifest, reducedMotion, progressRef]);

  // Cover-fit depends on the canvas's own box size, so a resize needs a repaint of whatever
  // is already on screen (poster or the last decoded frame).
  useEffect(() => {
    const onResize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const idx = lastDrawnRef.current;
      const img = idx >= 0 ? imagesRef.current[idx] : undefined;
      if (img) drawCover(canvas, img, dprCap.current);
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!manifest) return null;

  if (reducedMotion) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={manifest.poster} alt="" className="scr-canvas-poster" />;
  }

  return <canvas ref={canvasRef} className="scr-canvas" aria-hidden="true" />;
}
