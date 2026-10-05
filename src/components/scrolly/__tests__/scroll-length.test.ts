import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HERO_PINNED_VIEWPORTS, roomHeightVh, scrollPxPerFrame } from '../room-rules';
import {
  frameIndexForProgress,
  nextFrameToLoad,
  shouldKeepFrame,
  nearestReadyFrame,
  LOAD_AHEAD,
  SKELETON_STRIDE,
} from '../CanvasSequence';

const ROOT = path.resolve(__dirname, '../../../..');
const manifest = (k: 'desktop' | 'mobile') =>
  JSON.parse(readFileSync(path.join(ROOT, `public/generated/hero-rise/${k}/manifest.json`), 'utf8'));

describe('section height rule', () => {
  it('the room is the pinned scroll plus the one viewport the sticky stage occupies', () => {
    expect(roomHeightVh(0)).toBe(100);
    expect(roomHeightVh(3.2)).toBe(420); // the first version
    expect(roomHeightVh(HERO_PINNED_VIEWPORTS.mobile)).toBe(700);
    expect(roomHeightVh(HERO_PINNED_VIEWPORTS.desktop)).toBe(550);
  });

  it('a phone pins 4 to 6 viewports, a desktop longer than before (3.2) but shorter than a phone', () => {
    expect(HERO_PINNED_VIEWPORTS.mobile).toBeGreaterThanOrEqual(4);
    expect(HERO_PINNED_VIEWPORTS.mobile).toBeLessThanOrEqual(6);
    expect(HERO_PINNED_VIEWPORTS.desktop).toBeGreaterThan(3.2);
    expect(HERO_PINNED_VIEWPORTS.desktop).toBeLessThan(HERO_PINNED_VIEWPORTS.mobile);
  });

  it('on a 390x844 phone each frame step is finer and a normal swipe moves only a small part', () => {
    const m = manifest('mobile');
    const before = scrollPxPerFrame(844, 3.2, 30);
    const after = scrollPxPerFrame(844, HERO_PINNED_VIEWPORTS.mobile, m.frameCount);
    expect(Math.round(before)).toBe(93);
    expect(after).toBeLessThan(before); // finer steps
    // a 250 px swipe moves a small part of the whole sequence
    expect(250 / (844 * HERO_PINNED_VIEWPORTS.mobile)).toBeLessThan(0.06);
  });
});

describe('frame sequence files', () => {
  it('ship 2x to 3x the old frame counts (60 desktop, 30 phone)', () => {
    expect(manifest('desktop').frameCount).toBeGreaterThanOrEqual(120);
    expect(manifest('mobile').frameCount).toBeGreaterThanOrEqual(60);
  });
});

describe('frame index mapping on the longer sequence', () => {
  it('maps the ends and the middle of the scroll to the first, middle and last frame', () => {
    expect(frameIndexForProgress(0, 150)).toBe(0);
    expect(frameIndexForProgress(0.5, 91)).toBe(45);
    expect(frameIndexForProgress(1, 150)).toBe(149);
  });
  it('moves one frame per 1/(count-1) of progress', () => {
    const n = 90;
    for (let i = 0; i < n; i++) expect(frameIndexForProgress(i / (n - 1), n)).toBe(i);
  });
});

describe('progressive loading', () => {
  it('starts with the playhead, then the frames just ahead, then a few behind', () => {
    const requested = new Array(150).fill(false);
    const order: number[] = [];
    for (let k = 0; k < 4; k++) {
      const i = nextFrameToLoad(50, requested);
      requested[i] = true;
      order.push(i);
    }
    expect(order).toEqual([50, 51, 49, 52]);
  });

  it('never asks for a frame outside the window or the skeleton until the playhead moves', () => {
    const requested = new Array(150).fill(false);
    for (let i = nextFrameToLoad(0, requested); i !== -1; i = nextFrameToLoad(0, requested)) {
      expect(i <= LOAD_AHEAD || i % SKELETON_STRIDE === 0).toBe(true);
      requested[i] = true;
    }
    expect(requested.filter(Boolean).length).toBeLessThan(150);
    expect(nextFrameToLoad(0, requested)).toBe(-1);
    // the playhead moved: new frames are due
    expect(nextFrameToLoad(100, requested)).toBe(100);
  });

  it('keeps a decoded stand-in within the neighbour search of every frame once the skeleton is in', () => {
    const ready = new Array(150).fill(false);
    for (let i = 0; i < 150; i += SKELETON_STRIDE) ready[i] = true;
    for (let t = 0; t < 150; t++) expect(nearestReadyFrame(t, ready)).not.toBe(-1);
  });

  it('releases frames far behind the playhead but keeps the skeleton', () => {
    expect(shouldKeepFrame(7, 100)).toBe(false);
    expect(shouldKeepFrame(6, 100)).toBe(true);
    expect(shouldKeepFrame(95, 100)).toBe(true);
    expect(shouldKeepFrame(147, 100)).toBe(true); // inside KEEP_AHEAD (the skeleton keeps every 6th frame anyway)
    expect(shouldKeepFrame(149, 100)).toBe(false);
  });
});

describe('mobile scroll length, in the stylesheet and the landing wiring', () => {
  const css = readFileSync(path.join(ROOT, 'src/components/scrolly/scrolly.css'), 'utf8');

  it('the room height comes from custom properties and a phone breakpoint swaps in the longer one', () => {
    expect(css).toMatch(/\.scr-room\s*\{[^}]*height:\s*var\(--scr-room-h\)/);
    expect(css).toMatch(/@media \(max-width: 767px\)\s*\{\s*\.scr-room\s*\{\s*height:\s*var\(--scr-room-h-mobile/);
  });

  it('the landing page passes both lengths from the rules module, not a fixed number', () => {
    const landing = readFileSync(path.join(ROOT, 'src/components/landing/HammerpriceLanding.tsx'), 'utf8');
    expect(landing).toMatch(/durationVh=\{roomHeightVh\(HERO_PINNED_VIEWPORTS\.desktop\)\}/);
    expect(landing).toMatch(/mobileDurationVh=\{roomHeightVh\(HERO_PINNED_VIEWPORTS\.mobile\)\}/);
  });

  it('the breakpoint matches the one CanvasSequence uses to pick the phone frames (768)', () => {
    const canvas = readFileSync(path.join(ROOT, 'src/components/scrolly/CanvasSequence.tsx'), 'utf8');
    expect(canvas).toMatch(/MOBILE_BREAKPOINT = 768/);
  });
});
