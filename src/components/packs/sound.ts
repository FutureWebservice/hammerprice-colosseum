/**
 * Optional sound for the pack opening, synthesized with the Web Audio API (no audio files, nothing to download, nothing is requested from
 * anywhere). OFF by default: the context is created only when the visitor switches the sound on (a user gesture), and every call is a no-op
 * without it. Short, quiet, no autoplay.
 */
import type { RarityLevel } from '@/lib/packs/rarity';

export type SfxKind = 'shake' | 'tear' | 'burst' | 'flip';
export interface Sfx { play(kind: SfxKind, rarity?: RarityLevel): void; close(): void }

type AudioCtor = typeof AudioContext;
const ctor = (): AudioCtor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
};

const NOTES: Record<RarityLevel, number[]> = {
  common: [392],
  uncommon: [392, 494],
  rare: [392, 494, 587],
  epic: [392, 494, 587, 784],
  legendary: [392, 523, 659, 784, 1047],
};

/** null when the browser has no Web Audio. Call from a click handler. */
export function createSfx(): Sfx | null {
  const C = ctor();
  if (!C) return null;
  let ctx: AudioContext;
  try { ctx = new C(); } catch { return null; }
  void ctx.resume?.();

  const noise = (dur: number, from: number, to: number, gain: number, at = 0) => {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    const t0 = ctx.currentTime + at;
    filter.frequency.setValueAtTime(from, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start(t0);
  };
  const tone = (freq: number, dur: number, gain: number, at = 0, type: OscillatorType = 'sine') => {
    const o = ctx.createOscillator();
    o.type = type;
    const t0 = ctx.currentTime + at;
    o.frequency.setValueAtTime(freq, t0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  };

  return {
    play(kind, rarity = 'common') {
      try {
        if (kind === 'shake') { for (let i = 0; i < 5; i++) noise(0.12, 180, 90, 0.08, i * 0.16); }
        else if (kind === 'tear') noise(0.45, 900, 5200, 0.12);
        else if (kind === 'flip') tone(220, 0.12, 0.05, 0, 'triangle');
        else NOTES[rarity].forEach((f, i) => tone(f, 0.9, 0.05, i * 0.07));
      } catch { /* sound is a nicety: never break the opening */ }
    },
    close() { void ctx.close?.(); },
  };
}
