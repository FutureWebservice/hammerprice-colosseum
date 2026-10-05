/**
 * What an uploaded picture must be. Pure (bytes in, a verdict out). The type comes from the bytes, never from the file name or the declared
 * content type; SVG and every other format is refused. The file is stored as it came (no decoder runs on the server, no new dependency), so
 * the checks are strict instead: a known signature, the format's own end marker (no hidden trailer), a plausible size in pixels and at most 200 KB.
 */
import { AVATAR_MAX_BYTES, type AvatarType } from '@/contracts/profile';

export const AVATAR_MAX_SIDE = 4096;
export type AvatarVerdict = { ok: true; type: AvatarType; width: number; height: number } | { ok: false; rule: 'avatar_empty' | 'avatar_size' | 'avatar_type' };

const startsWith = (b: Uint8Array, sig: number[], at = 0): boolean => sig.every((v, i) => b[at + i] === v);
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

function png(b: Uint8Array): { width: number; height: number } | null {
  if (!startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || b.length < 33 || !startsWith(b, [0x49, 0x48, 0x44, 0x52], 12)) return null;
  if (!startsWith(b, [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], b.length - 8)) return null; // IEND and its CRC close the file
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpeg(b: Uint8Array): { width: number; height: number } | null {
  if (!startsWith(b, [0xff, 0xd8, 0xff]) || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] }; // a start-of-frame marker
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

function webp(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30 || !startsWith(b, [0x52, 0x49, 0x46, 0x46]) || !startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return null;
  if (((b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0) + 8 !== b.length) return null; // the RIFF size must be the file size: no trailer
  const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (kind === 'VP8X') return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (kind === 'VP8 ' && startsWith(b, [0x9d, 0x01, 0x2a], 23)) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (kind === 'VP8L' && b[20] === 0x2f) { const v = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0; return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }; }
  return null;
}

export function checkAvatarBytes(b: Uint8Array): AvatarVerdict {
  if (b.length === 0) return { ok: false, rule: 'avatar_empty' };
  if (b.length > AVATAR_MAX_BYTES) return { ok: false, rule: 'avatar_size' };
  const found: [AvatarType, { width: number; height: number } | null][] = [['image/png', png(b)], ['image/jpeg', jpeg(b)], ['image/webp', webp(b)]];
  const hit = found.find(([, d]) => d !== null);
  if (!hit || !hit[1]) return { ok: false, rule: 'avatar_type' };
  const { width, height } = hit[1];
  if (width < 1 || height < 1 || width > AVATAR_MAX_SIDE || height > AVATAR_MAX_SIDE) return { ok: false, rule: 'avatar_size' };
  return { ok: true, type: hit[0], width, height };
}
