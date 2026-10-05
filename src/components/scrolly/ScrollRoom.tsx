'use client';

/**
 * The pinned "hammer falls" hero room (story-spec.json's hero-rise room).
 *
 * A tall spacer (`durationVh` viewport-heights) holds a sticky, viewport-filling stage. A
 * CanvasSequence scrubs through the pre-rendered frame sequence as that spacer scrolls past;
 * real DOM copy for each beat cross-fades over it by its own 0..1 range within that scroll.
 *
 * Progressive enhancement, not a loading state: the component always mounts server-rendered
 * as the plain, un-pinned fallback below (poster + stacked beat copy + the CTA) - the same
 * markup a no-JS visitor, a manifest-missing deploy, or prefers-reduced-motion sees forever.
 * Only after mount, once we know JS runs and motion is allowed, does an effect flip it over
 * to the pinned scroll-scrubbed version. Server and first client render are identical, so
 * there is no hydration mismatch.
 */
import { useEffect, useRef, useState } from 'react';
import CanvasSequence, { frameUrl, type FrameManifest } from './CanvasSequence';
import { FADE_FRACTION, STRIKE_FALL, attachSettle, calmZones } from './settle';
import CardGallery from '@/components/gallery/CardGallery';
import type { VaultCard } from '@/lib/vault/collector-crypt';
import './scrolly.css';

export interface ScrollBeat {
  id: string;
  range: [number, number];
  /** Small uppercase mono line above the heading - a category tag, not a sentence. */
  kicker?: string;
  /** The beat that carries one becomes the page's one visible <h1>. At most one beat should
   *  set this - ScrollRoom doesn't enforce it, the room's own beat list does. */
  heading?: string;
  copy: string | null;
  /** Up to three buttons, all the same solid brass style: the primary one, then optionally two more. */
  cta?: { label: string; href: string; /** A second button next to the primary one. */ alt?: { label: string; href: string }; secondary?: { label: string; href: string } };
  /** The auctioneer's calls, dropped one after another into the empty space above the beat's
   *  copy as the visitor scrolls through it. Each one falls like a hammer and lands hard; the
   *  next replaces it. Two is the auction's own rhythm ("Zum Ersten", "Zum Zweiten"). */
  strikes?: string[];
}

function Cta({ cta }: { cta: NonNullable<ScrollBeat['cta']> }) {
  return (
    <div className="scr-cta-row">
      <a className="scr-cta" href={cta.href}>
        {cta.label}
      </a>
      {cta.alt && (
        <a className="scr-cta" href={cta.alt.href} data-testid="landing-ai-cta">
          {cta.alt.label}
        </a>
      )}
      {cta.secondary && (
        <a className="scr-cta" href={cta.secondary.href}>
          {cta.secondary.label}
        </a>
      )}
    </div>
  );
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Cross-fade opacity for a beat at scroll progress p: fades in over the first
 *  FADE_FRACTION of its range, holds, fades out over the last FADE_FRACTION. Pure + testable.
 *
 *  The edges of the room are not cross-fades. A beat starting at 0 is already on screen when
 *  the page loads - fading it in from nothing means the visitor's first sight of the site is
 *  an empty stage, which is exactly what happened. Same at the other end: a beat running to 1
 *  should still be readable at the bottom of the room, not dissolving as it is reached. */
export function beatOpacity(p: number, [start, end]: [number, number]): number {
  if (end <= start) return p >= start ? 1 : 0;
  if (p < start || p > end) return 0;
  const span = end - start;
  const fadeIn = start + span * FADE_FRACTION;
  const fadeOut = end - span * FADE_FRACTION;
  if (start > 0 && p < fadeIn) return clamp01((p - start) / (fadeIn - start));
  if (end < 1 && p > fadeOut) return clamp01(1 - (p - fadeOut) / (end - fadeOut));
  return 1;
}

/** Where a hammer-strike word sits at local progress `lp`, given `n` strikes sharing the beat.
 *
 *  Each strike owns an equal slice. Inside its slice it falls from above and lands in the first
 *  third, then holds: the drop is scroll-driven, so the visitor swings it themselves rather than
 *  watching a canned animation. `drop` is how far above its resting place the word still is, in
 *  em, and it eases out hard (quartic) so the word arrives fast and stops dead, the way a gavel
 *  does. Pure + testable. */
export function strikeAt(lp: number, index: number, n: number): { drop: number; opacity: number } {
  if (n <= 0) return { drop: 0, opacity: 0 };
  const slice = 1 / n;
  const local = (clamp01(lp) - index * slice) / slice;
  if (local < 0 || local > 1) return { drop: 0, opacity: 0 };
  const FALL = STRIKE_FALL; // of its own slice
  if (local >= FALL) return { drop: 0, opacity: 1 };
  const t = local / FALL;
  const eased = 1 - Math.pow(1 - t, 4);
  return { drop: (1 - eased) * 1.1, opacity: eased };
}

/** p mapped into a beat's own 0..1 local progress. Pure + testable. */
export function localProgress(p: number, [start, end]: [number, number]): number {
  if (end <= start) return p >= start ? 1 : 0;
  return clamp01((p - start) / (end - start));
}

/** A short, decaying pulse near the start of a beat's range - the hammer-strike flash.
 *  Peaks at the beat's start and is fully decayed by 12% into it. Pure + testable. */
export function hammerFlash(p: number, [start, end]: [number, number]): number {
  const span = Math.max(end - start, 0.0001);
  if (p < start) return 0;
  return clamp01(1 - (p - start) / (span * 0.12));
}

export default function ScrollRoom({
  durationVh,
  mobileDurationVh = durationVh,
  beats,
  ticks,
  showcaseCards,
  desktopManifest,
  mobileManifest,
}: {
  /** Room height in vh on desktop, and (below 768 px, see scrolly.css) on phones. Both are CSS custom
   *  properties, so the server-rendered height is already the right one for the viewport: no layout shift. */
  durationVh: number;
  mobileDurationVh?: number;
  beats: ScrollBeat[];
  ticks: string[];
  /** Real vault cards for the opening beat's rotating showcase: front AND back faces. */
  showcaseCards: VaultCard[];
  desktopManifest: FrameManifest | null;
  mobileManifest: FrameManifest | null;
}) {
  const coldOpenBeat = beats.find((b) => b.id === 'cold-open');
  // Server-rendered as the pinned room (not the plain fallback): the hero the visitor sees is
  // then in the HTML itself, so its poster and cards are discovered by the preload scanner
  // instead of after hydration swaps one tree for another. The effect below flips to the
  // fallback for prefers-reduced-motion. Server and first client render agree (both read props).
  const [enhanced, setEnhanced] = useState(!!(desktopManifest || mobileManifest));
  const roomRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(0);
  const beatNodes = useRef<(HTMLDivElement | null)[]>([]);
  const hairlineRef = useRef<HTMLDivElement>(null);
  const hammerFlashRef = useRef<HTMLDivElement>(null);
  const strikeNodes = useRef<(HTMLDivElement | null)[]>([]);

  const hairlineBeat = beats.find((b) => b.id === 'final-ten');
  const strikeBeat = beats.find((b) => b.strikes && b.strikes.length > 0);
  const hammerBeat = beats.find((b) => b.id === 'hammer-falls');
  const posterSrc = desktopManifest?.poster ?? mobileManifest?.poster ?? null;
  const firstManifest = desktopManifest ?? mobileManifest;
  const firstFrame = firstManifest ? frameUrl(firstManifest.frameUrlTemplate, 0) : null;

  // Decide once whether to enhance, and keep deciding if the OS-level reduced-motion
  // setting changes mid-session.
  useEffect(() => {
    const hasSequence = !!(desktopManifest || mobileManifest);
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const decide = () => setEnhanced(hasSequence && !mql.matches);
    decide();
    mql.addEventListener('change', decide);
    return () => mql.removeEventListener('change', decide);
  }, [desktopManifest, mobileManifest]);

  // The stage pins itself with plain `position: sticky` (scrolly.css) - nothing here writes
  // position/top/left/width. That only works because globals.css no longer sets
  // `overflow-x: hidden` on body (it stayed on html only): overflow-x on body used to make it
  // its own scroll container, which is the ancestor sticky resolves against, so sticky never
  // engaged there. With that fixed, all this effect has to do is turn scroll position into a
  // 0..1 progress number, once per animation frame - not on every 'scroll' event, so a fast
  // scroll or a mid-scroll resize can't leave beats or the canvas frame stuck on a stale read.
  useEffect(() => {
    if (!enhanced) return;
    const room = roomRef.current;
    if (!room) return;

    let lastP = -1;
    const update = () => {
      const rect = room.getBoundingClientRect();
      const vh = window.innerHeight;
      const total = rect.height - vh;
      const p = total > 0 ? clamp01(-rect.top / total) : 0;
      if (p === lastP) return; // nothing moved: no style writes this frame
      lastP = p;
      progressRef.current = p;

      beats.forEach((b, i) => {
        const node = beatNodes.current[i];
        if (node) node.style.opacity = String(beatOpacity(p, b.range));
      });
      if (hairlineBeat && hairlineRef.current) {
        const lp = localProgress(p, hairlineBeat.range);
        hairlineRef.current.style.transform = `scaleX(${1 - lp})`;
        hairlineRef.current.classList.toggle('is-final', lp > 0.66);
      }
      if (hammerBeat && hammerFlashRef.current) {
        hammerFlashRef.current.style.opacity = String(hammerFlash(p, hammerBeat.range));
      }
      if (strikeBeat?.strikes) {
        const lp = localProgress(p, strikeBeat.range);
        const n = strikeBeat.strikes.length;
        strikeBeat.strikes.forEach((_, i) => {
          const node = strikeNodes.current[i];
          if (!node) return;
          const { drop, opacity } = strikeAt(lp, i, n);
          node.style.opacity = String(opacity);
          // translate3d, not translateY: keeps the word on its own compositor layer so a word
          // this large does not repaint the beat behind it on every frame of the fall.
          node.style.transform = `translate3d(0, ${-drop}em, 0)`;
        });
      }
    };
    let raf = requestAnimationFrame(function loop() {
      update();
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
    // beats/hairlineBeat/hammerBeat are derived from a prop that doesn't change after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enhanced]);

  // After the scroll stops between two beats, ease to the middle of the nearest calm one (settle.ts): resting on a half-faded line reads as a bug.
  useEffect(() => {
    const room = roomRef.current;
    if (!enhanced || !room) return;
    return attachSettle({
      room,
      zones: calmZones(beats),
      reducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    // beats is a prop that doesn't change after mount (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enhanced]);

  return (
    <>
      {!enhanced && (
        <section className="scr-fallback">
          {posterSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={posterSrc} alt="" className="scr-fallback-poster" />
          )}
          <div className="scr-fallback-copy">
            {beats.map((b) => (
              <div key={b.id} className={`scr-fallback-beat scr-fallback-beat--${b.id}`}>
                {b.kicker && <p className="scr-beat-kicker">{b.kicker}</p>}
                {b.heading && <h1 className="scr-beat-heading">{b.heading}</h1>}
                {b.copy && <p>{b.copy}</p>}
                {b.id === 'bids-stack' && ticks.length > 0 && (
                  <p className="scr-fallback-ticks">{ticks.join(' · ')}</p>
                )}
                {b.id === 'cold-open' && <CardGallery cards={showcaseCards} />}
                {b.cta && <Cta cta={b.cta} />}
              </div>
            ))}
          </div>
        </section>
      )}

      {enhanced && (
        <section ref={roomRef} className="scr-room" style={{ '--scr-room-h': `${durationVh}vh`, '--scr-room-h-mobile': `${mobileDurationVh}vh` } as React.CSSProperties}>
          <div className="scr-stage">
            {/* The scrub's first frame, in the HTML: the stage's first paint is what the canvas shows at progress 0, so
                nothing flashes when the canvas takes over once JS has run and the frames have decoded. */}
            {firstFrame && (
              <picture>
                {mobileManifest && <source media="(max-width: 767px)" srcSet={frameUrl(mobileManifest.frameUrlTemplate, 0)} />}
                <img src={firstFrame} alt="" className="scr-canvas-poster" fetchPriority="high" decoding="async" />
              </picture>
            )}
            <CanvasSequence desktop={desktopManifest} mobile={mobileManifest} progressRef={progressRef} />
            <div className="scr-beats">
              {beats.map((b, i) => (
                <div
                  key={b.id}
                  ref={(el) => {
                    beatNodes.current[i] = el;
                  }}
                  className={`scr-beat scr-beat--${b.id}`}
                  // Server-rendered opacity, so the room reads before hydration and still
                  // reads if the scroll effect never runs at all. Whatever is on screen at
                  // progress 0 is what a visitor with no JavaScript keeps.
                  style={{ opacity: beatOpacity(0, b.range) }}
                >
                  {b.strikes && b.strikes.length > 0 && (
                    <div className="scr-strikes" aria-hidden="true">
                      {b.strikes.map((word, si) => (
                        <div
                          key={word}
                          ref={(el) => {
                            strikeNodes.current[si] = el;
                          }}
                          className="scr-strike"
                          // Server-rendered resting position, same reasoning as the beats above:
                          // whatever progress 0 shows is what a visitor without the scroll
                          // effect keeps.
                          style={{
                            opacity: strikeAt(0, si, b.strikes!.length).opacity,
                            transform: `translate3d(0, ${-strikeAt(0, si, b.strikes!.length).drop}em, 0)`,
                          }}
                        >
                          {word}
                        </div>
                      ))}
                    </div>
                  )}
                  {b.kicker && <p className="scr-beat-kicker">{b.kicker}</p>}
                  {b.heading && <h1 className="scr-beat-heading">{b.heading}</h1>}
                  {b.copy && <p className="scr-beat-copy">{b.copy}</p>}
                  {b.id === 'bids-stack' && (
                    <ul className="scr-ticks">
                      {ticks.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  )}
                  {b.id === 'final-ten' && (
                    <div className="scr-hairline-track">
                      <div ref={hairlineRef} className="scr-hairline" />
                    </div>
                  )}
                  {b.id === 'hammer-falls' && <div ref={hammerFlashRef} className="scr-hammer-flash" />}
                  {b.id === 'cold-open' && (
                    <CardGallery
                      cards={showcaseCards}
                      progressRef={progressRef}
                      beatRange={coldOpenBeat?.range}
                    />
                  )}
                  {b.cta && <Cta cta={b.cta} />}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
