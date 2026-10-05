/**
 * The ONE text the VRF key ever proves: alpha. Strict like BidIntentV1 (lib/auth/intent.ts): fixed field order,
 * one field per line, "\n" separators, no trailing newline, lowercase canonical numbers and ids, printable ASCII.
 * A parser that accepts exactly one spelling means "parse, then compare fields" is the whole check, and the
 * prover refuses anything that is not an alpha (the key cannot be talked into proving arbitrary text).
 *
 *   hammerprice vrf v1
 *   cluster: <devnet | mainnet-beta>
 *   purpose: <lot_order | raffle | pack_pull>
 *   subject: <request id, lowercase uuid>
 *   params: <sha256 hex of the canonical params>
 *   beacon: <slot>:<blockhash base58>
 */
import bs58 from 'bs58';
import type { Cluster } from '@/contracts';
import { UUID_RE } from './commitment';
import { VrfError, isCluster, type AlphaPurpose, type Beacon } from './types';

export const ALPHA_HEADER = 'hammerprice vrf v1';
export const ALPHA_PURPOSES: readonly AlphaPurpose[] = ['lot_order', 'raffle', 'pack_pull'];

export interface Alpha {
  cluster: Cluster;
  purpose: AlphaPurpose;
  subject: string;
  paramsHash: string;
  beacon: Beacon;
}

const SLOT = /^[1-9][0-9]{0,15}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A base58 string that decodes to exactly 32 bytes (a blockhash or a public key). */
export function isBase58Key32(s: string): boolean {
  if (!B58.test(s)) return false;
  try { return bs58.decode(s).length === 32; } catch { return false; }
}

export function buildAlpha(a: Alpha): string {
  if (!isCluster(a.cluster)) throw new VrfError('bad_alpha', 'unknown cluster');
  if (!ALPHA_PURPOSES.includes(a.purpose)) throw new VrfError('bad_alpha', 'unknown purpose');
  if (!UUID_RE.test(a.subject)) throw new VrfError('bad_alpha', 'subject is not a lowercase uuid');
  if (!HEX64.test(a.paramsHash)) throw new VrfError('bad_alpha', 'params hash is not sha256 hex');
  if (!SLOT.test(String(a.beacon.slot))) throw new VrfError('bad_alpha', 'beacon slot is not a positive integer');
  if (!isBase58Key32(a.beacon.blockhash)) throw new VrfError('bad_alpha', 'beacon blockhash is not a base58 hash');
  return [
    ALPHA_HEADER,
    `cluster: ${a.cluster}`,
    `purpose: ${a.purpose}`,
    `subject: ${a.subject}`,
    `params: ${a.paramsHash}`,
    `beacon: ${a.beacon.slot}:${a.beacon.blockhash}`,
  ].join('\n');
}

/** Throws VrfError('bad_alpha') for anything but the exact canonical spelling. */
export function parseAlpha(text: string): Alpha {
  const lines = text.split('\n');
  const fail = (): never => { throw new VrfError('bad_alpha', 'not a canonical hammerprice vrf v1 alpha'); };
  if (lines.length !== 6 || lines[0] !== ALPHA_HEADER) fail();
  const field = (i: number, key: string): string => {
    const l = lines[i]!;
    return l.startsWith(`${key}: `) ? l.slice(key.length + 2) : fail();
  };
  const beacon = field(5, 'beacon');
  const colon = beacon.indexOf(':');
  if (colon < 1) fail();
  const a: Alpha = {
    cluster: field(1, 'cluster') as Cluster,
    purpose: field(2, 'purpose') as AlphaPurpose,
    subject: field(3, 'subject'),
    paramsHash: field(4, 'params'),
    beacon: { slot: Number(beacon.slice(0, colon)), blockhash: beacon.slice(colon + 1) },
  };
  let rebuilt: string;
  try { rebuilt = buildAlpha(a); } catch { return fail(); }
  if (rebuilt !== text) fail();
  return a;
}
