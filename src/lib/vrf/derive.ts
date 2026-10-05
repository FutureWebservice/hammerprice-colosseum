/**
 * From the 64-byte VRF output to a result, in public, fixed steps (golden vectors in __tests__/vectors.json):
 *
 *   block(i)     = SHA-512(output || u32be(i))                       64 bytes
 *   word(k)      = bytes [(k & 7) * 8, +8) of block(k >> 3), big endian u64
 *   uniformInt(n)= take the next word w; if w >= floor(2^64 / n) * n take the next one; else w mod n
 *   shuffle      = Fisher-Yates from the back: for i = len-1 .. 1: j = uniformInt(i + 1); swap(a[i], a[j])
 *   draw         = uniformInt(n) on a fresh stream
 */
import { sha512 } from '@noble/hashes/sha2';
import { concat, u32be } from './bytes';
import { VrfError } from './types';

const TWO64 = 1n << 64n;

export class WordStream {
  private k = 0;
  private blockIndex = -1;
  private block: Uint8Array = new Uint8Array(0);
  constructor(private readonly output: Uint8Array) {
    if (output.length !== 64) throw new VrfError('bad_input', 'a VRF output is 64 bytes');
  }
  next(): bigint {
    const bi = this.k >> 3;
    if (bi !== this.blockIndex) { this.block = sha512(concat(this.output, u32be(bi))); this.blockIndex = bi; }
    const o = (this.k & 7) * 8;
    this.k++;
    let w = 0n;
    for (let i = 0; i < 8; i++) w = (w << 8n) | BigInt(this.block[o + i]!);
    return w;
  }
  /** Uniform in [0, n), n a positive safe integer; rejection sampling removes modulo bias. */
  uniformInt(n: number): number {
    if (!Number.isSafeInteger(n) || n < 1) throw new VrfError('bad_input', 'n must be a positive integer');
    const big = BigInt(n);
    const limit = (TWO64 / big) * big;
    for (;;) {
      const w = this.next();
      if (w < limit) return Number(w % big);
    }
  }
}

export function shuffle<T>(output: Uint8Array, items: readonly T[]): T[] {
  const a = [...items];
  const s = new WordStream(output);
  for (let i = a.length - 1; i >= 1; i--) {
    const j = s.uniformInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export const drawIndex = (output: Uint8Array, n: number): number => new WordStream(output).uniformInt(n);

/** Lot ids in play order for ids given by original number ascending. */
export const lotOrderFromOutput = (output: Uint8Array, idsByNumber: readonly string[]): string[] => shuffle(output, idsByNumber);
/** The winning paddle number, entrants ascending. */
export const raffleWinnerFromOutput = (output: Uint8Array, entrants: readonly number[]): number => entrants[drawIndex(output, entrants.length)]!;
