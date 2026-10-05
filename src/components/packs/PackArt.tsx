'use client';

/**
 * A booster pack, the kind that hangs on a shop wall: a tall 5:8 wrapper in a colour family chosen by the pack's rarest tier (teal to emerald, violet
 * to magenta, crimson to orange; brass is only the trim), a holographic foil with fine diagonal bands, a hero of radiating light, a card fan and a
 * hammer, a ribbon with the set name, a row of tier symbols, a barcode strip, crimped zigzag seals with fold shading and a wrinkled, glossy surface.
 * Everything is inline SVG and CSS (no asset, nothing copied). The pointer tilts it and moves a specular band (touch and reduced motion: static).
 * Only transform and opacity animate. The top seal is its own layer (`pk-pack-lid`) so the opening can tear it off. The pack is announced by one label.
 */
import { useId, useRef } from 'react';
import { RARITY_LEVELS, rarityOf, type RarityLevel } from '@/lib/packs/rarity';
import { hueOf } from './format';
import { usePackT } from './usePackT';

export function HammerGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 5.5 18 10" /><path d="M10 9 14.5 4 20 9.5 15 14Z" /><path d="M11.5 12.5 4 20" /><path d="M4 21h6" />
    </svg>
  );
}

type Odds = readonly { tier: string; bps: number }[];

/** The accent of a pack: the look of its rarest tier (from the published odds only). */
export function accentOf(odds: Odds): RarityLevel {
  const look = rarityOf(odds);
  return Object.values(look).reduce<RarityLevel>((top, r) => (RARITY_LEVELS.indexOf(r) > RARITY_LEVELS.indexOf(top) ? r : top), 'common');
}

/**
 * Colour family of a pack (`data-family`), from the chance of its rarest tier: a chase pack (2 percent or less) is crimson to orange, a pack with a rare
 * tier (up to 15 percent) is violet to magenta, anything else is teal to emerald. Looks are relative (the rarest tier of any pack is "legendary"), the chance is not.
 */
export const familyOf = (odds?: Odds): 'emerald' | 'violet' | 'crimson' => {
  const rarest = odds && odds.length ? Math.min(...odds.map((o) => o.bps)) : 10_000;
  return rarest <= 200 ? 'crimson' : rarest <= 1500 ? 'violet' : 'emerald';
};

const W = 250, H = 400, TEAR = 34;

/** Small deterministic random numbers from a string: the same pack always looks the same, on the server and in the browser. */
function rng(seed: string) {
  let a = 2166136261;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 16777619);
  return () => { a += 0x6d2b79f5; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const f = (n: number) => Math.round(n * 10) / 10;
/** A zigzag along y from x=0 to x=W with teeth of the given size (the crimped edge of a wrapper). */
const teeth = (y: number, dir: 1 | -1, size: number, jitter: () => number) => {
  const pts: string[] = [];
  for (let x = 0; x < W; x += size) { pts.push(`${f(x)},${f(y)}`); pts.push(`${f(x + size / 2)},${f(y + dir * (size * 0.55 + jitter() * 1.2))}`); }
  pts.push(`${W},${f(y)}`);
  return pts;
};
const star = (s: number) => `M0,${-s}L${s * 0.22},${-s * 0.22}L${s},0L${s * 0.22},${s * 0.22}L0,${s}L${-s * 0.22},${s * 0.22}L${-s},0L${-s * 0.22},${-s * 0.22}Z`;

function geometry(seed: string) {
  const r = rng(seed);
  const jag = () => r();
  // the torn line (shared by the lid and the body, so they meet exactly)
  const tear: [number, number][] = [];
  for (let x = 0; x < W; x += 7) tear.push([x, TEAR + (r() - 0.5) * 5]);
  tear.push([W, TEAR]);
  const tearPts = tear.map(([x, y]) => `${f(x)},${f(y)}`);
  const top = teeth(3, -1, 5, jag);
  const bottom = teeth(H - 3, 1, 5, jag).reverse();
  const lid = `M${top.join(' L')} L${[...tearPts].reverse().join(' L')} Z`;
  const body = `M${tearPts.join(' L')} L${bottom.join(' L')} Z`;
  const rays = Array.from({ length: 28 }, (_, i) => {
    const a = (i / 28) * Math.PI * 2, w = 0.045 + (i % 2) * 0.03, len = 118 + (i % 3) * 14;
    return `M0,0L${f(Math.cos(a - w) * len)},${f(Math.sin(a - w) * len)}L${f(Math.cos(a + w) * len)},${f(Math.sin(a + w) * len)}Z`;
  }).join('');
  const sparkles = Array.from({ length: 11 }, () => ({ x: 20 + r() * 210, y: 52 + r() * 160, s: 2 + r() * 4.5, o: 0.5 + r() * 0.5 }));
  const bars: { x: number; w: number }[] = [];
  for (let x = 62; x < 196; ) { const w = 1 + Math.floor(r() * 3); bars.push({ x, w }); x += w + 1 + Math.floor(r() * 3); }
  return { lid, body, rays, sparkles, bars, noise: Math.floor(r() * 90) + 1 };
}

function Wrapper({ part, uid, seed }: { part: 'lid' | 'body'; uid: string; seed: string }) {
  const g = geometry(seed);
  const id = (n: string) => `${uid}${n}`;
  const ref = (n: string) => `url(#${id(n)})`;
  const isBody = part === 'body';
  return (
    <svg className={`pk-pack-svg pk-pack-svg--${part}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" focusable="false" aria-hidden="true">
      <defs>
        <linearGradient id={id('b')} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}><stop offset="0" style={{ stopColor: 'var(--c3)' }} /><stop offset=".16" style={{ stopColor: 'var(--c1)' }} /><stop offset=".55" style={{ stopColor: 'var(--c2)' }} /><stop offset=".86" style={{ stopColor: 'var(--c1)' }} /><stop offset="1" style={{ stopColor: 'var(--c3)' }} /></linearGradient>
        <linearGradient id={id('h')} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={W} y2={H}>
          {['#ff7ab6', '#ffd86f', '#6fffd0', '#6fb7ff', '#c56fff', '#ff7ab6'].map((c, i) => <stop key={i} offset={i / 5} stopColor={c} />)}
        </linearGradient>
        <radialGradient id={id('r')} cx="0" cy="0" r="130" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#fff" stopOpacity=".55" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient>
        <radialGradient id={id('l')} cx="125" cy="150" r="150" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#fff" stopOpacity=".5" /><stop offset=".5" stopColor="#fff" stopOpacity=".08" /><stop offset="1" stopColor="#000" stopOpacity=".25" /></radialGradient>
        <linearGradient id={id('c')} x1="0" y1="0" x2="1" y2="1"><stop offset="0" style={{ stopColor: 'var(--c2)' }} /><stop offset="1" style={{ stopColor: 'var(--c3)' }} /></linearGradient>
        <linearGradient id={id('t')} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#e8c776" /><stop offset="1" stopColor="#8a6d2a" /></linearGradient>
        <linearGradient id={id('f')} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".45" /></linearGradient>
        <linearGradient id={id('e')} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#000" stopOpacity=".5" /><stop offset=".04" stopColor="#fff" stopOpacity=".28" /><stop offset=".1" stopColor="#000" stopOpacity="0" /><stop offset=".9" stopColor="#000" stopOpacity="0" /><stop offset=".96" stopColor="#fff" stopOpacity=".18" /><stop offset="1" stopColor="#000" stopOpacity=".55" /></linearGradient>
        <pattern id={id('s')} width="3" height="6" patternUnits="userSpaceOnUse"><rect width="1.2" height="6" fill="#000" opacity=".4" /><rect x="1.6" width="1" height="6" fill="#fff" opacity=".34" /></pattern>
        <pattern id={id('d')} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(32)"><rect width="2.4" height="12" fill="#fff" opacity=".22" /><rect x="5" width=".8" height="12" fill="#fff" opacity=".12" /></pattern>
        <clipPath id={id('k')}><path d={isBody ? g.body : g.lid} /></clipPath>
        <filter id={id('w')} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".011 .042" numOctaves="3" seed={g.noise} result="n" />
          <feDiffuseLighting in="n" lightingColor="#fff" surfaceScale="2.6"><feDistantLight azimuth="235" elevation="52" /></feDiffuseLighting>
        </filter>
        <filter id={id('n')} x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed={g.noise + 3} /><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .7 0" /></filter>
      </defs>
      <g clipPath={ref('k')}>
        <rect width={W} height={H} fill={ref('b')} />
        <rect width={W} height={H} fill={ref('h')} opacity=".34" style={{ mixBlendMode: 'overlay' }} />
        <rect width={W} height={H} fill={ref('d')} />
        <rect width={W} height={H} fill={ref('l')} style={{ mixBlendMode: 'soft-light' }} />
        {isBody && (
          <g>
            <g transform="translate(125 148)"><path d={g.rays} fill={ref('r')} style={{ mixBlendMode: 'screen' }} opacity=".75" /></g>
            <circle cx="125" cy="148" r="62" fill="#fff" opacity=".08" /><circle cx="125" cy="148" r="46" fill="none" stroke="#fff" strokeOpacity=".28" strokeWidth=".8" />
            {[-21, 21, 0].map((a, i) => (
              <g key={a} transform={`rotate(${a} 125 222)`}>
                <rect x="85" y="104" width="80" height="112" rx="7" fill="#0b0e13" opacity=".5" transform="translate(1.5 3)" />
                <rect x="85" y="104" width="80" height="112" rx="7" fill={i === 2 ? ref('h') : ref('c')} stroke="#fff" strokeOpacity=".7" strokeWidth="1.2" />
                <rect x="91" y="110" width="68" height="100" rx="4" fill="none" stroke="#fff" strokeOpacity=".32" strokeWidth=".8" />
                {i === 2 && <path d={`M91,206 L159,128 L159,142 L103,210Z`} fill="#fff" opacity=".35" />}
              </g>
            ))}
            <g transform="translate(125 156) scale(4.9) translate(-12 -12)" fill="none" strokeLinecap="round" strokeLinejoin="round">
              <g stroke="#000" strokeOpacity=".45" strokeWidth="3.4" transform="translate(.25 .45)"><path d="M13.5 5.5 18 10" /><path d="M10 9 14.5 4 20 9.5 15 14Z" /><path d="M11.5 12.5 4 20" /></g>
              <g stroke={ref('t')} strokeWidth="2.1"><path d="M13.5 5.5 18 10" /><path d="M10 9 14.5 4 20 9.5 15 14Z" fill="#e8c776" fillOpacity=".25" /><path d="M11.5 12.5 4 20" /></g>
            </g>
            <path d={star(15)} transform="translate(40 76)" fill="#fff" opacity=".9" /><path d={star(10)} transform="translate(214 118)" fill="#fff" opacity=".85" />
            {g.sparkles.map((s, i) => <path key={i} d={star(s.s)} transform={`translate(${f(s.x)} ${f(s.y)})`} fill="#fff" opacity={f(s.o)} />)}
            {/* the ribbon: a dark plate with brass trim and folded tails */}
            <path d="M8,236 L30,236 L30,300 L8,300 L17,268Z" fill="#05070a" opacity=".85" /><path d="M242,236 L220,236 L220,300 L242,300 L233,268Z" fill="#05070a" opacity=".85" />
            <path d="M30,296 L38,306 L38,296Z M220,296 L212,306 L212,296Z" fill="#000" opacity=".7" />
            <rect x="22" y="222" width="206" height="76" rx="3" fill="#0d1117" />
            <rect x="22" y="222" width="206" height="76" rx="3" fill="none" stroke={ref('t')} strokeWidth="1.6" />
            <rect x="27" y="227" width="196" height="66" rx="2" fill="none" stroke="#e8c776" strokeOpacity=".35" strokeWidth=".7" />
            {/* the legal strip: 18+, the barcode */}
            <rect x="26" y="334" width="198" height="34" rx="2.5" fill="#f4f0e6" /><rect x="26" y="334" width="198" height="34" rx="2.5" fill={ref('e')} opacity=".5" />
            <circle cx="42" cy="351" r="9" fill="none" stroke="#14110a" strokeWidth="1.3" /><text x="42" y="354.3" textAnchor="middle" fontSize="9" fontWeight="700" fill="#14110a" fontFamily="ui-monospace, Menlo, monospace">18+</text>
            {g.bars.map((b, i) => <rect key={i} x={b.x} y="339" width={b.w} height="21" fill="#14110a" />)}
            <rect x="62" y="361" width="134" height="1" fill="#14110a" opacity=".5" />
          </g>
        )}
        {/* the crimped seals: ridges, fold shading, a lit lip */}
        {!isBody && (<g><rect width={W} height="30" fill={ref('s')} /><rect y="22" width={W} height="9" fill="#000" opacity=".28" /><rect y="28.5" width={W} height="1.4" fill="#fff" opacity=".55" /><rect y="2" width={W} height="1.1" fill="#fff" opacity=".4" /></g>)}
        {isBody && (<g><rect y="371" width={W} height="29" fill={ref('s')} /><rect y="371" width={W} height="1.6" fill="#fff" opacity=".5" /><rect y="372.6" width={W} height="8" fill="#000" opacity=".3" /><rect y="352" width={W} height="19" fill={ref('f')} opacity=".7" /></g>)}
        <rect width={W} height={H} fill={ref('e')} />
        <rect width={W} height={H} filter={ref('w')} opacity=".42" style={{ mixBlendMode: 'overlay' }} />
        <rect width={W} height={H} filter={ref('n')} opacity=".22" style={{ mixBlendMode: 'soft-light' }} />
      </g>
    </svg>
  );
}

const SHAPES: Record<RarityLevel, string> = {
  common: 'M0,-5 A5,5 0 1,0 0.01,-5Z',
  uncommon: 'M0,-6L5,0L0,6L-5,0Z',
  rare: star(6.5),
  epic: 'M0,-6L5.2,-3L5.2,3L0,6L-5.2,3L-5.2,-3Z',
  legendary: `${star(7.5)}M0,-3.2L3.2,0L0,3.2L-3.2,0Z`,
};

export default function PackArt({ name, seed, tag, large = false, odds, count }: { name: string; seed: string; tag?: string; large?: boolean; odds?: Odds; count?: number }) {
  const t = usePackT();
  const root = useRef<HTMLDivElement>(null);
  const uid = `pa${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const accent = odds ? accentOf(odds) : 'rare';
  const look = odds ? rarityOf(odds) : {};
  const levels = odds ? [...new Set(Object.values(look))].sort((a, b) => RARITY_LEVELS.indexOf(a) - RARITY_LEVELS.indexOf(b)).slice(0, 6) : [];
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = root.current;
    if (!el || e.pointerType === 'touch') return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    el.style.setProperty('--sx', ((x - 0.5) * 100).toFixed(1));
    el.style.setProperty('--sy', ((y - 0.5) * 100).toFixed(1));
    el.style.setProperty('--rx', `${((x - 0.5) * 14).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${((0.5 - y) * 14).toFixed(2)}deg`);
  };
  const leave = () => { for (const k of ['--sx', '--sy', '--rx', '--ry']) root.current?.style.removeProperty(k); };
  const cards = count !== undefined ? t('art.cards', { n: count }) : null;
  return (
    <div
      ref={root} className={`pk-pack${large ? ' pk-pack--large' : ''}`} data-rarity={accent} data-family={familyOf(odds)} style={{ ['--h' as string]: hueOf(seed) }}
      role="img" aria-label={t('art.aria', { name, cards: cards ?? '' }).trim()} data-testid="pack-art" onPointerMove={move} onPointerLeave={leave}
    >
      <div className="pk-pack-tilt">
        <div className="pk-pack-body">
          <Wrapper part="body" uid={`${uid}b`} seed={seed} />
          <div className="pk-pack-text" aria-hidden="true">
            {tag && <div className="pk-pack-tag">{tag}</div>}
            <div className="pk-pack-word">Hammerprice</div>
            <div className="pk-pack-name">{name}</div>
            <div className="pk-pack-sub">{t('art.booster')}{cards ? ` · ${cards}` : ''}</div>
            <div className="pk-pack-tiers">
              {levels.map((l) => <svg key={l} viewBox="-8 -8 16 16" data-rarity={l}><path d={SHAPES[l]} fillRule="evenodd" /></svg>)}
            </div>
          </div>
          <div className="pk-pack-sheen" />
        </div>
        <div className="pk-pack-lid"><Wrapper part="lid" uid={`${uid}l`} seed={seed} /><div className="pk-pack-sheen" /></div>
        <div className="pk-pack-split" />
      </div>
    </div>
  );
}
