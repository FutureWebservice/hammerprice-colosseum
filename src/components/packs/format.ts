import { formatUsdc } from '@/components/auction/types';

export const shortAddress = (a: string): string => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** A stable hue (0 to 359) from an id, so every pack has its own foil without any asset. */
export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export const usd = (units: string | null | undefined, locale: string): string => formatUsdc(units, locale);
