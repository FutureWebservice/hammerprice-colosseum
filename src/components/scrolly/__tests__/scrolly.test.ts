import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { frameIndexForProgress, frameUrl, nearestReadyFrame } from '../CanvasSequence';
import { beatOpacity, localProgress, hammerFlash, strikeAt } from '../ScrollRoom';

describe('frameIndexForProgress', () => {
  it('maps 0 and 1 to the first and last frame', () => {
    expect(frameIndexForProgress(0, 96)).toBe(0);
    expect(frameIndexForProgress(1, 96)).toBe(95);
  });
  it('clamps out-of-range progress', () => {
    expect(frameIndexForProgress(-0.5, 96)).toBe(0);
    expect(frameIndexForProgress(1.5, 96)).toBe(95);
  });
});

describe('frameUrl', () => {
  it('fills the 1-indexed, zero-padded placeholder', () => {
    expect(frameUrl('/generated/hero-rise/desktop/frame-%04d.jpg', 0)).toBe(
      '/generated/hero-rise/desktop/frame-0001.jpg',
    );
    expect(frameUrl('/generated/hero-rise/desktop/frame-%04d.jpg', 95)).toBe(
      '/generated/hero-rise/desktop/frame-0096.jpg',
    );
  });
});

describe('nearestReadyFrame', () => {
  it('returns the target frame itself when ready', () => {
    const ready = new Array(10).fill(false);
    ready[5] = true;
    expect(nearestReadyFrame(5, ready)).toBe(5);
  });
  it('falls back to a decoded neighbour behind the target - never blank while catching up', () => {
    const ready = new Array(10).fill(false);
    ready[3] = true;
    expect(nearestReadyFrame(5, ready)).toBe(3);
  });
  it('falls forward when nothing behind the target is ready yet', () => {
    const ready = new Array(10).fill(false);
    ready[7] = true;
    expect(nearestReadyFrame(5, ready)).toBe(7);
  });
  it('returns -1 when nothing nearby is ready, so the caller keeps the last frame', () => {
    const ready = new Array(20).fill(false);
    expect(nearestReadyFrame(5, ready)).toBe(-1);
  });
});

describe('beatOpacity', () => {
  const range: [number, number] = [0.2, 0.4];
  it('is 0 outside the range', () => {
    expect(beatOpacity(0.1, range)).toBe(0);
    expect(beatOpacity(0.5, range)).toBe(0);
  });
  it('is 1 in the held middle of the range', () => {
    expect(beatOpacity(0.3, range)).toBe(1);
  });
  it('fades in from the start and out to the end', () => {
    expect(beatOpacity(0.2, range)).toBe(0);
    expect(beatOpacity(0.4, range)).toBe(0);
    const mid = beatOpacity(0.225, range);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('localProgress', () => {
  it('maps a beat range to its own 0..1', () => {
    expect(localProgress(0.46, [0.46, 0.62])).toBe(0);
    expect(localProgress(0.62, [0.46, 0.62])).toBe(1);
    expect(localProgress(0.54, [0.46, 0.62])).toBeCloseTo(0.5, 1);
  });
});

describe('hammerFlash', () => {
  const range: [number, number] = [0.62, 0.74];
  it('is 0 before the beat starts', () => {
    expect(hammerFlash(0.6, range)).toBe(0);
  });
  it('peaks at the beat start and decays quickly within it', () => {
    expect(hammerFlash(0.62, range)).toBe(1);
    expect(hammerFlash(0.74, range)).toBe(0);
    const partway = hammerFlash(0.63, range);
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThan(1);
  });
});

describe('beatOpacity at the edges of the room', () => {
  // The bug this guards: the first beat's range starts at 0, the fade-in returned 0 there,
  // and the landing page's first screen was an empty stage with no copy and no CTA.
  it('shows a beat that starts at 0 immediately, with no fade-in', () => {
    expect(beatOpacity(0, [0, 0.12])).toBe(1);
    expect(beatOpacity(0.01, [0, 0.12])).toBe(1);
  });

  it('keeps a beat that runs to 1 readable at the bottom of the room', () => {
    expect(beatOpacity(1, [0.88, 1])).toBe(1);
    expect(beatOpacity(0.99, [0.88, 1])).toBe(1);
  });

  it('still cross-fades a beat in the middle of the room', () => {
    expect(beatOpacity(0.28, [0.28, 0.46])).toBe(0);
    expect(beatOpacity(0.37, [0.28, 0.46])).toBe(1);
    expect(beatOpacity(0.46, [0.28, 0.46])).toBe(0);
  });

  it('is still 0 outside the range', () => {
    expect(beatOpacity(0.5, [0, 0.12])).toBe(0);
    expect(beatOpacity(0.5, [0.88, 1])).toBe(0);
  });
});

describe('strikeAt: the auctioneer swings the gavel on scroll', () => {
  it('is invisible before its own slice and after it', () => {
    expect(strikeAt(0.9, 0, 2).opacity).toBe(0);   // first word, second half
    expect(strikeAt(0.1, 1, 2).opacity).toBe(0);   // second word, first half
  });

  it('starts high and lands at rest inside its slice', () => {
    const start = strikeAt(0, 0, 2);
    expect(start.drop).toBeGreaterThan(0.9);
    expect(start.opacity).toBeLessThan(0.1);
    const landed = strikeAt(0.35, 0, 2);           // past the fall, still in slice one
    expect(landed.drop).toBe(0);
    expect(landed.opacity).toBe(1);
  });

  it('falls, never rises: drop decreases monotonically through the fall', () => {
    let prev = Infinity;
    for (let lp = 0; lp <= 0.17; lp += 0.01) {
      const d = strikeAt(lp, 0, 2).drop;
      expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
    }
  });

  it('gives each word an equal slice and hands over cleanly', () => {
    expect(strikeAt(0.49, 0, 2).opacity).toBe(1);
    expect(strikeAt(0.51, 0, 2).opacity).toBe(0);
    expect(strikeAt(0.85, 1, 2).opacity).toBe(1);
  });

  it('is inert when there is nothing to strike', () => {
    expect(strikeAt(0.5, 0, 0)).toEqual({ drop: 0, opacity: 0 });
  });
});

// The lot caption once sat dead centre of the stage, which is where the slab rises through, so it
// printed over the PSA label. Guard: it is anchored to the top band (above the slab's highest
// resting place, same band as the strikes), on a solid plate, with no scrim pool behind it, and
// the gallery's own captions sit on a plate too. Checked in the stylesheet.
describe('hero captions stay off the slab', () => {
  const css = readFileSync(path.resolve(__dirname, '../scrolly.css'), 'utf8');
  const gal = readFileSync(path.resolve(__dirname, '../../gallery/gallery.css'), 'utf8');
  const rule = (src: string, sel: string) => {
    const esc = sel.replace(/[.\\-]/g, '\\$&');
    const m = src.match(new RegExp('(?:^|\\n)' + esc + '\\s*\\{([^}]*)\\}'));
    return m ? m[1] : '';
  };

  it('the lot beat is top-anchored, not centred over the slab', () => {
    const beat = rule(css, '.scr-beat--lot-rises');
    expect(beat).toMatch(/justify-content:\s*flex-start/);
    expect(beat).toMatch(/padding-top:\s*clamp\(\d+px,\s*[1-8]vh,/); // at most 8vh: the slab top is never above 30vh
  });

  it('the lot caption has a solid plate and no scrim pool', () => {
    const copy = rule(css, '.scr-beat--lot-rises .scr-beat-copy');
    const alpha = copy.match(/background:\s*rgba\([^)]*,\s*(\.\d+|0?\.\d+|1)\)/);
    expect(alpha).not.toBeNull();
    expect(Number(alpha![1])).toBeGreaterThanOrEqual(0.8);
    expect(css).not.toMatch(/\.scr-beat--lot-rises \.scr-beat-copy::before/);
  });

  it('the gallery captions sit on a plate under each card', () => {
    expect(rule(gal, '.gal-cap')).toMatch(/background:\s*rgba\(/);
  });
});

// The four middle beats (bids-stack, final-ten, hammer-falls, price-stamps) used to be centred over the slab, and the
// first one touched the label's lower edge. Their text now sits in a left column on landscape screens and in the band
// above the slab on phones and portrait tablets. The slab is centred and its size follows how the frame is covered into
// the stage, so the column can be checked with the same arithmetic the stylesheet uses.
describe('the middle beats stay off the slab', () => {
  const css = readFileSync(path.resolve(__dirname, '../scrolly.css'), 'utf8');
  const BEATS = ['bids-stack', 'final-ten', 'hammer-falls', 'price-stamps'];
  const block = (head: RegExp) => {
    const i = css.search(head);
    if (i < 0) return '';
    let depth = 0;
    for (let j = css.indexOf('{', i); j < css.length; j++) {
      if (css[j] === '{') depth++;
      if (css[j] === '}' && --depth === 0) return css.slice(i, j + 1);
    }
    return '';
  };
  const wide = block(/@media \(min-aspect-ratio: 6\/5\) \{/);
  const half = wide.match(/--slab-half:\s*max\(([\d.]+)vw,\s*([\d.]+)vh\)/);
  const slabHalf = (vw: number, vh: number) => Math.max((Number(half![1]) * vw) / 100, (Number(half![2]) * vh) / 100);

  it('every one of the four is top-anchored by default and has no scrim pool', () => {
    for (const b of BEATS) expect(css, b).not.toContain(`.scr-beat--${b} .scr-beat-copy::before`);
    expect(css).toMatch(/\.scr-beat--bids-stack, \.scr-beat--final-ten, \.scr-beat--hammer-falls, \.scr-beat--price-stamps \{[^}]*justify-content:\s*flex-start/);
  });

  it('on a landscape screen they sit in a left column that ends before the slab', () => {
    expect(half).not.toBeNull();
    for (const b of BEATS) expect(wide, b).toContain(`.scr-beat--${b}`);
    expect(wide).toMatch(/padding-right:\s*calc\(50% \+ var\(--slab-half\) \+ \d+px\)/);
  });

  it('the half-width covers what was measured in a browser (px), and the column stays readable', () => {
    for (const [vw, vh, measured] of [[1280, 800, 142], [1440, 600, 124], [1024, 768, 136], [1920, 900, 170]]) {
      expect(slabHalf(vw, vh), `${vw}x${vh}`).toBeGreaterThanOrEqual(measured);
      const column = vw / 2 - slabHalf(vw, vh) - 28 - Math.min(72, Math.max(24, vw * 0.04));
      expect(column, `${vw}x${vh} column`).toBeGreaterThanOrEqual(280);
    }
  });

  it('the strikes end above the slab top (27% of the stage on a short wide screen) and the copy sits under them', () => {
    expect(css).toMatch(/--strike-size:\s*clamp\(34px,\s*min\(7\.6vw,\s*12vh\),\s*104px\)/);
    expect(css).toMatch(/font-size:\s*var\(--strike-size\)/);
    for (const [vw, vh] of [[1280, 800], [1440, 600], [1024, 768], [1920, 900], [2560, 1080], [1366, 768]]) {
      const size = Math.min(104, Math.max(34, Math.min(0.076 * vw, 0.12 * vh)));
      expect(0.07 * vh + 1.3 * size, `${vw}x${vh}`).toBeLessThanOrEqual(0.26 * vh);
    }
    expect(css).toMatch(/\.scr-beat--final-ten \{ padding-top: calc\(9vh \+ 1\.3 \* var\(--strike-size\)/);
  });

  it('a phone held sideways keeps the column with the strikes dropped, and a portrait screen gets a row of ticks', () => {
    expect(css).toMatch(/@media \(max-width: 767px\) and \(min-aspect-ratio: 6\/5\)/);
    expect(css).toContain('.scr-beat .scr-strikes { display: none; }');
    expect(css).toMatch(/@media \(max-width: 767px\), \(max-aspect-ratio: 6\/5\) \{\s*\.scr-ticks \{\s*flex-direction: row/);
  });
});

describe('the opening statement never starts under the header', () => {
  const css = readFileSync(path.resolve(__dirname, '../scrolly.css'), 'utf8');
  it('a column taller than the stage starts at its top (safe center) with air above it on short screens', () => {
    expect(css).toContain('.scr-beat--cold-open { justify-content: safe center; }');
    expect(css).toMatch(/@media \(max-height: 720px\) \{ \.scr-beat--cold-open \{ padding-block: 12px; \} \}/);
    expect(css).toMatch(/@media \(max-width: 767px\) and \(max-height: 720px\) \{\s*\.scr-beat--cold-open \{ gap: 8px; padding-block: 16px 12px; \}/);
  });
});
