'use client';

/**
 * The opening: the pack shakes, tears, a burst of light, the card rises face down, flips to its face with a holographic sheen and a
 * glow in the colour of its rarity. Reduced motion: the card is simply there (no timers, no keyframes). Sound is optional and off unless the
 * parent passes a ready `sfx`. "Skip animation" jumps to the end; the result is announced in a polite live region either way.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RarityLevel } from '@/lib/packs/rarity';
import '../ui/hpx.css';
import HoloCard from './HoloCard';
import PackArt from './PackArt';
import { timeline, type Phase } from './reveal';
import type { Sfx } from './sound';
import { useReducedMotion } from './useReducedMotion';

export interface RevealCard { name: string; imageUrl: string | null }

/** Sparks that leave the card when it turns face up: more of them for a rarer card; fixed positions (a golden-angle spiral) so server and browser render the same. */
const SPARKS = { common: 6, uncommon: 9, rare: 12, epic: 16, legendary: 22 } as const;
const sparks = (rarity: RarityLevel) => Array.from({ length: SPARKS[rarity] }, (_, i) => {
  const a = i * 2.39996, r = 0.62 + (i % 4) * 0.13;
  return { x: (Math.cos(a) * r).toFixed(3), y: (Math.sin(a) * r * 1.2).toFixed(3), dl: `${((i % 6) * 0.07).toFixed(2)}s` };
});

export default function RevealStage({ card, rarity, odds, count, packName, packSeed, houseTag, sfx, labels, onShown }: {
  card: RevealCard;
  rarity: RarityLevel;
  odds: readonly { tier: string; bps: number }[];
  count: number;
  packName: string;
  packSeed: string;
  houseTag?: string;
  sfx: Sfx | null;
  labels: { sealed: string; tearing: string; shown: string; skip: string };
  onShown?: () => void;
}) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>('sealed');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const sfxRef = useRef(sfx);
  sfxRef.current = sfx; // sound may be switched on while the opening runs
  const shown = useRef(false);
  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };

  const finish = useCallback(() => {
    clear();
    setPhase('shown');
    if (!shown.current) { shown.current = true; onShown?.(); }
  }, [onShown]);

  useEffect(() => {
    clear();
    if (reduced) { finish(); return clear; }
    let at = 0;
    for (const step of timeline(rarity, false)) {
      at += step.after;
      timers.current.push(setTimeout(() => {
        setPhase(step.phase);
        if (step.phase === 'shake') sfxRef.current?.play('shake');
        else if (step.phase === 'tear') sfxRef.current?.play('tear');
        else if (step.phase === 'burst') sfxRef.current?.play('burst', rarity);
        else if (step.phase === 'flip') sfxRef.current?.play('flip');
        else if (step.phase === 'shown') finish();
      }, at));
    }
    return clear;
    // the timeline is started once per card
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, rarity, card.name]);

  const flipped = reduced || phase === 'flip' || phase === 'shown';
  const status = phase === 'sealed' ? labels.sealed : phase === 'flip' || phase === 'shown' ? labels.shown : labels.tearing;
  return (
    <div className="pk-stage" data-phase={reduced ? 'shown' : phase} data-reduced={reduced ? 'true' : 'false'} data-rarity={rarity} data-testid="reveal-stage">
      <div className="pk-aura" />
      <div className="pk-rays" />
      <div className="pk-burst" />
      <div className="pk-stage-inner">
        <PackArt name={packName} seed={packSeed} tag={houseTag} odds={odds} count={count} large />
        <div className="pk-card-slot"><HoloCard name={card.name} imageUrl={card.imageUrl} rarity={rarity} flipped={flipped} /></div>
        <div className="pk-particles" aria-hidden="true">
          {sparks(rarity).map((p, i) => <i key={i} style={{ ['--x' as string]: p.x, ['--y' as string]: p.y, ['--dl' as string]: p.dl }} />)}
        </div>
      </div>
      <p className="pk-sr" role="status" aria-live="polite">{status}</p>
      {!reduced && phase !== 'shown' && (
        <button type="button" className="hpx-btn hpx-btn--ghost" onClick={finish} style={{ position: 'absolute', right: 0, top: 0, minHeight: 36, padding: '0 14px', fontSize: 11 }} data-testid="reveal-skip">{labels.skip}</button>
      )}
    </div>
  );
}
