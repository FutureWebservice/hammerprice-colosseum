'use client';

/**
 * One card with its rarity glow and a holographic sheen that follows the pointer (a slow idle drift on touch and when the pointer is away).
 * The back is the Hammerprice card back. `flipped` turns it to the face (CSS 3D); with reduced motion the parent never flips, it shows the
 * face. The face is the card's own image, or its name when there is none.
 */
import { useRef } from 'react';
import type { RarityLevel } from '@/lib/packs/rarity';
import { HammerGlyph } from './PackArt';

export default function HoloCard({ name, imageUrl, rarity, flipped, interactive = true, alt }: { name: string; imageUrl: string | null; rarity: RarityLevel; flipped: boolean; interactive?: boolean; alt?: string }) {
  const tilt = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || !tilt.current || e.pointerType === 'touch') return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const el = tilt.current;
    el.style.setProperty('--mx', `${Math.round(x * 100)}%`);
    el.style.setProperty('--my', `${Math.round(y * 100)}%`);
    el.style.setProperty('--rx', `${((x - 0.5) * 14).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${((0.5 - y) * 14).toFixed(2)}deg`);
  };
  const leave = () => {
    const el = tilt.current;
    if (!el) return;
    for (const k of ['--mx', '--my', '--rx', '--ry']) el.style.removeProperty(k);
  };
  return (
    <div className="pk-tilt" ref={tilt} onPointerMove={move} onPointerLeave={leave} data-testid="holo-card">
      <div className="pk-card" data-flipped={flipped ? 'true' : 'false'} data-rarity={rarity}>
        <div className="pk-face pk-face--front">
          {imageUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="pk-art" src={imageUrl} alt={alt ?? name} decoding="async" />
            : <div className="pk-art pk-art--empty" role="img" aria-label={alt ?? name}>{name}</div>}
          <div className="pk-holo" />
          <div className="pk-sparkle" />
          <div className="pk-glare" />
        </div>
        <div className="pk-face pk-face--back" aria-hidden="true"><HammerGlyph /></div>
      </div>
    </div>
  );
}
