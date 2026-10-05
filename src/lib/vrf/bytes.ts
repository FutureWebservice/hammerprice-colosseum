/** Byte helpers without Buffer or node:*, so the same code runs in the browser. */
import { VrfError } from './types';

const enc = new TextEncoder();
export const utf8 = (s: string): Uint8Array => enc.encode(s);

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

/** Lowercase hex of even length only; anything else is refused (there is one spelling of a hash). */
export function fromHex(h: string, bytes?: number): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(h) || (bytes !== undefined && h.length !== bytes * 2)) {
    throw new VrfError('bad_input', bytes === undefined ? 'not lowercase hex' : `expected ${bytes} bytes of lowercase hex`);
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const u32be = (n: number): Uint8Array => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
