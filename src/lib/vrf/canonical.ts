/**
 * Canonical JSON for committed parameters: keys sorted recursively, no whitespace, integers only, UTF-8.
 * `paramsHash = sha256(utf8(canonicalJson(params)))` as lowercase hex. Anyone can recompute it from the stored params.
 */
import { sha256 } from '@noble/hashes/sha2';
import { toHex, utf8 } from './bytes';
import { VrfError } from './types';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new VrfError('bad_input', 'canonical JSON allows integers only');
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new VrfError('bad_input', 'value is not JSON');
}

export const sha256Hex = (s: string | Uint8Array): string => toHex(sha256(typeof s === 'string' ? utf8(s) : s));

export const paramsHashOf = (params: unknown): string => sha256Hex(canonicalJson(params));
