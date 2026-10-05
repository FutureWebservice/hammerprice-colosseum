/**
 * Line-art for the explain panels - brass strokes, no fill, drawn in the same vocabulary as
 * the rest of the room: the graded slab, the gavel, a wallet glyph, a chain of blocks. Not
 * stock art, not emoji. `currentColor` so the wrapping `.ex-panel-icon` sets the brass.
 */
import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 96 96',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.25,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

/** A graded slab already sitting in a wallet. */
export function VaultIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="10" y="10" width="34" height="50" rx="3" />
      <circle cx="27" cy="24" r="7" />
      <path d="M20 40h14M20 47h10" />
      <path d="M40 58 68 70" strokeDasharray="1 6" />
      <rect x="46" y="52" width="40" height="30" rx="4" />
      <path d="M46 62h40" />
      <circle cx="66" cy="72" r="3" />
    </svg>
  );
}

/** A room: screen (video) over a catalogue list, with a paddle/bid tag. */
export function RoomIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="10" y="12" width="52" height="36" rx="3" />
      <path d="M31 22v16l14-8-14-8Z" fill="currentColor" stroke="none" />
      <path d="M10 58h30M10 66h22M10 74h26" />
      <rect x="66" y="58" width="20" height="24" rx="3" />
      <path d="M76 58V50l-6 8h12l-6-8Z" />
    </svg>
  );
}

/** A signed message over a wallet, with the transfer that does not happen. */
export function SignatureIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="12" y="10" width="44" height="30" rx="3" />
      <path d="M20 34c4-10 6-10 9-2s5 8 8-2 5-9 8-1" />
      <path d="M34 46v10" />
      <rect x="16" y="56" width="36" height="26" rx="4" />
      <path d="M16 66h36" />
      <circle cx="42" cy="70" r="2.5" />
      <path d="M58 68h18" strokeDasharray="1 6" />
      <path d="M80 62l6 6-6 6" />
    </svg>
  );
}

/** A clock face with its last seconds marked: the server clock that closes the lot. */
export function ClockIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <circle cx="48" cy="50" r="32" />
      <path d="M48 50V30M48 50l14 8" />
      <path d="M40 12h16" />
      <path d="M48 12v6" />
      <path d="M48 24v2M48 74v2M22 50h2M72 50h2" />
      <path d="M68 22l6-6" />
    </svg>
  );
}

/** The gavel strike, splitting into a coin (USDC) and a card: the settlement. */
export function HammerIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M22 20l14 14" />
      <rect x="14" y="8" width="20" height="12" rx="2" transform="rotate(-45 24 14)" />
      <path d="M40 36l14 14" />
      <path d="M48 60v20" />
      <path d="M38 82h20" />
      <ellipse cx="48" cy="52" rx="10" ry="4" />
      <path d="M46 48l-22 10" strokeDasharray="1 6" />
      <circle cx="18" cy="62" r="9" />
      <path d="M14 62h8M18 58v8" />
      <path d="M52 48l24 6" strokeDasharray="1 6" />
      <rect x="72" y="46" width="18" height="24" rx="2" />
    </svg>
  );
}

/** A hand-off passing straight through the platform, and an open lock. */
export function CustodyIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <circle cx="48" cy="46" r="30" />
      <path d="M10 46h20M66 46h20" />
      <path d="M22 46l8-6M22 46l8 6M74 46l-8-6M74 46l-8 6" />
      <rect x="40" y="42" width="16" height="14" rx="2" />
      <path d="M43 42v-6a5 5 0 0 1 9-3" />
    </svg>
  );
}

/** A screen with a play mark - what you are watching, plainly labeled. */
export function ScreenIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="10" y="16" width="76" height="50" rx="4" />
      <path d="M40 30v22l20-11-20-11Z" fill="currentColor" stroke="none" />
      <path d="M32 78h32M48 66v12" />
      <circle cx="76" cy="24" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export const PANEL_ICONS = {
  vault: VaultIcon,
  room: RoomIcon,
  signature: SignatureIcon,
  hammer: ClockIcon,
  settle: HammerIcon,
  custody: CustodyIcon,
  demo: ScreenIcon,
} as const;
