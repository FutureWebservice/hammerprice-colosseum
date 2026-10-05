'use client';

/**
 * One rotating slab: real front and back photography from the Collector Crypt vault, in a
 * CSS 3D card that always idle-spins (so the hero has motion the instant it paints) and, when
 * `outerRef` is wired up by CardGallery's scroll loop, layers an extra scroll-driven turn on
 * top via an outer wrapper - two nested `preserve-3d` transforms compose in true 3D, so the
 * idle spin keeps running through the extra turn instead of being replaced by it.
 *
 * A real graded card lives in a rigid slab, not a paper-thin sheet - two edge strips (only
 * left/right come into view as the card turns around its vertical axis) catch a brass gradient
 * so the turn reads as an object with depth, not a flat sticker.
 *
 * prefers-reduced-motion: no spin wrapper at all, just the front face and the caption. Still
 * the real card, still beautiful, never moving.
 */
import type { VaultCard } from '@/lib/vault/collector-crypt';

const IDLE_PERIOD_S = 22;

/** Phase-shifts each card's idle spin so a row of cards doesn't turn in lockstep.
 *  A negative animation-delay starts the CSS animation already partway through its cycle.
 *  Pure + testable. */
export function idleDelay(index: number, total: number, periodSec: number = IDLE_PERIOD_S): number {
  if (total <= 0 || index <= 0) return 0;
  return -((index / total) * periodSec);
}

/** Exponential ease-out, 0..1 -> 0..1. Fast start, long soft settle, never overshoots past 1 -
 *  the "ease-out, exponential, no bounce" the design brief asks every motion to use.
 *  Pure + testable. */
export function easeOutExpo(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  if (c === 0) return 0;
  if (c === 1) return 1;
  return 1 - Math.pow(2, -10 * c);
}

/** Caps a card list to the first `max` - the fan-spinning-up-a-laptop guard from the brief.
 *  Pure + testable. */
export function capShowcase<T>(cards: T[], max: number): T[] {
  return cards.slice(0, Math.max(0, max));
}

function money(value: number | null): string | null {
  return value == null ? null : `$${value.toLocaleString('en-US')}`;
}

export default function Card3D({
  card,
  index,
  total,
  reducedMotion,
  outerRef,
}: {
  card: VaultCard;
  index: number;
  total: number;
  reducedMotion: boolean;
  outerRef?: (el: HTMLDivElement | null) => void;
}) {
  const grade = [card.gradingCompany, card.grade].filter(Boolean).join(' ');
  const ask = money(card.price ?? card.insuredValue);

  const caption = (
    <figcaption className="gal-cap">
      {grade && <span className="gal-grade">{grade}</span>}
      <span className="gal-name">{card.name}</span>
      {ask && <span className="gal-price">{ask}</span>}
    </figcaption>
  );

  if (reducedMotion || !card.images.back) {
    return (
      <figure className="gal-card gal-card--static">
        {card.images.front && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.images.front} alt={card.name} loading="lazy" decoding="async" className="gal-static-img" />
        )}
        {caption}
      </figure>
    );
  }

  return (
    // Negative delay starts each card's float mid-cycle at a different phase, so the hand
    // breathes rather than bobbing in unison; the spin is phase-shifted the same way below.
    <figure className="gal-card" style={{ animationDelay: `${-(index * 1.3)}s` }}>
      <div className="gal-outer" ref={outerRef}>
        <div className="gal-spin" style={{ animationDelay: `${idleDelay(index, total)}s` }}>
          <div className="gal-face gal-face--front">
            {/* The first three fronts are the first thing on screen, on a phone as well (the CSS shows
                three there): fetch them first, not lazily. Cards four and five are hidden on a phone,
                so they stay lazy (a hidden eager image would still download). Backs stay lazy, they
                are only seen half a turn later. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={card.images.front} alt={card.name} loading={index < 3 ? 'eager' : 'lazy'} fetchPriority={index < 3 ? 'high' : undefined} decoding="async" />
          </div>
          <div className="gal-face gal-face--back">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={card.images.back} alt="" loading="lazy" decoding="async" />
          </div>
          <div className="gal-edge gal-edge--right" aria-hidden="true" />
          <div className="gal-edge gal-edge--left" aria-hidden="true" />
        </div>
      </div>
      {caption}
    </figure>
  );
}
