'use client';

/**
 * A row of real vault slabs, rotating.
 *
 * Every card idle-spins in CSS the moment it mounts - cheap (compositor-only, no JS per
 * frame) and it's what gives the hero motion on first paint, before anyone has scrolled.
 * When a scroll room hands this a `progressRef` (the same ref CanvasSequence reads - see
 * ScrollRoom.tsx) and the `beatRange` it lives inside, a second rAF loop layers one extra
 * scroll-driven turn on top, eased out so it settles rather than snapping. Used without
 * those two props - "elsewhere" outside a scroll room - a gallery is idle-only.
 *
 * prefers-reduced-motion is read once here, not per-card: one matchMedia listener, not N.
 */
import { useEffect, useRef, useState } from 'react';
import type { VaultCard } from '@/lib/vault/collector-crypt';
import { localProgress } from '@/components/scrolly/ScrollRoom';
import Card3D, { capShowcase, easeOutExpo } from './Card3D';
import './gallery.css';

const SCROLL_SPINS = 1.25; // extra full turns across the beat's own range

export default function CardGallery({
  cards,
  max = 5,
  progressRef,
  beatRange,
}: {
  cards: VaultCard[];
  max?: number;
  progressRef?: React.RefObject<number>;
  beatRange?: [number, number];
}) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const decide = () => setReducedMotion(mql.matches);
    decide();
    mql.addEventListener('change', decide);
    return () => mql.removeEventListener('change', decide);
  }, []);

  useEffect(() => {
    if (!progressRef || !beatRange || reducedMotion) return;
    let last = -1;
    let raf = requestAnimationFrame(function loop() {
      const lp = localProgress(progressRef.current ?? 0, beatRange);
      if (lp !== last) { // only when the scroll moved: no style writes on an idle frame
        last = lp;
        const t = `rotateY(${easeOutExpo(lp) * 360 * SCROLL_SPINS}deg)`;
        for (const el of cardRefs.current) if (el) el.style.transform = t;
      }
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [progressRef, beatRange, reducedMotion]);

  const shown = capShowcase(
    cards.filter((c) => c.images.front),
    max,
  );
  if (shown.length === 0) return null;

  return (
    <div className="gal-row" aria-hidden="true">
      {shown.map((c, i) => (
        <Card3D
          key={c.id}
          card={c}
          index={i}
          total={shown.length}
          reducedMotion={reducedMotion}
          outerRef={(el) => {
            cardRefs.current[i] = el;
          }}
        />
      ))}
    </div>
  );
}
