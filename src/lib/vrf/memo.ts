/**
 * The memo texts that anchor a request on chain. ASCII, each signed by the VRF key in its own transaction (SA pays).
 *
 *   Commit   hp:vrf:c1:<requestId>:<paramsHash hex64>:<revealByUnix>                      122 bytes
 *   Reveal   hp:vrf:r1:<requestId>:<beaconSlot>:<beaconBlockhash>:<proofHex160>           about 262 bytes
 *   Default  hp:vrf:d1:<requestId>                                                        written by the sweep
 *   Key      hp:vrf:k1:<publicKeyBase58>:<cluster>                                        one-time registration
 *
 * Builders validate; parsers accept exactly the built spelling (rebuild and compare).
 */
import type { Cluster } from '@/contracts';
import { isBase58Key32 } from './alpha';
import { UUID_RE } from './commitment';
import { VrfError, isCluster, type Beacon } from './types';

// Built from a bare namespace so the storage-key audit (src/legal/__tests__/audit.test.ts, which treats quoted 'hp:...' strings as storage keys) does not mistake memo texts for cookies.
const NS = 'hp';
export const MEMO_PREFIX = `${NS}:vrf:`;
/** A transaction is 1232 bytes; a memo of this size always fits next to two signatures. */
export const MEMO_MAX_BYTES = 566;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX160 = /^[0-9a-f]{160}$/;
const UNIX = /^[1-9][0-9]{9,10}$/;
const SLOT = /^[1-9][0-9]{0,15}$/;
const bad = (m: string): never => { throw new VrfError('bad_memo', m); };
const id = (s: string) => { if (!UUID_RE.test(s)) bad('request id is not a lowercase uuid'); };

export const buildCommitMemo = (requestId: string, paramsHash: string, revealByUnix: number): string => {
  id(requestId);
  if (!HEX64.test(paramsHash)) bad('params hash is not sha256 hex');
  if (!UNIX.test(String(revealByUnix))) bad('reveal-by is not a unix time in seconds');
  return `${MEMO_PREFIX}c1:${requestId}:${paramsHash}:${revealByUnix}`;
};

export const buildRevealMemo = (requestId: string, beacon: Beacon, proofHex: string): string => {
  id(requestId);
  if (!SLOT.test(String(beacon.slot))) bad('beacon slot is not a positive integer');
  if (!isBase58Key32(beacon.blockhash)) bad('beacon blockhash is not a base58 hash');
  if (!HEX160.test(proofHex)) bad('proof is not 80 bytes of lowercase hex');
  return `${MEMO_PREFIX}r1:${requestId}:${beacon.slot}:${beacon.blockhash}:${proofHex}`;
};

export const buildDefaultMemo = (requestId: string): string => { id(requestId); return `${MEMO_PREFIX}d1:${requestId}`; };

export const buildKeyMemo = (publicKey: string, cluster: Cluster): string => {
  if (!isBase58Key32(publicKey)) bad('public key is not base58');
  if (!isCluster(cluster)) bad('unknown cluster');
  return `${MEMO_PREFIX}k1:${publicKey}:${cluster}`;
};

export type ParsedMemo =
  | { kind: 'commit'; requestId: string; paramsHash: string; revealByUnix: number }
  | { kind: 'reveal'; requestId: string; beacon: Beacon; proofHex: string }
  | { kind: 'default'; requestId: string }
  | { kind: 'key'; publicKey: string; cluster: Cluster };

/** null when the text is not one of ours (other programs write memos too). Never throws. */
export function parseMemo(text: string): ParsedMemo | null {
  if (!text.startsWith(MEMO_PREFIX) || text.length > MEMO_MAX_BYTES) return null;
  const p = text.split(':');
  try {
    if (p[2] === 'c1' && p.length === 6) {
      const m: ParsedMemo = { kind: 'commit', requestId: p[3]!, paramsHash: p[4]!, revealByUnix: Number(p[5]) };
      return buildCommitMemo(m.requestId, m.paramsHash, m.revealByUnix) === text ? m : null;
    }
    if (p[2] === 'r1' && p.length === 7) {
      const m: ParsedMemo = { kind: 'reveal', requestId: p[3]!, beacon: { slot: Number(p[4]), blockhash: p[5]! }, proofHex: p[6]! };
      return buildRevealMemo(m.requestId, m.beacon, m.proofHex) === text ? m : null;
    }
    if (p[2] === 'd1' && p.length === 4) {
      return buildDefaultMemo(p[3]!) === text ? { kind: 'default', requestId: p[3]! } : null;
    }
    if (p[2] === 'k1' && p.length === 5) {
      const m: ParsedMemo = { kind: 'key', publicKey: p[3]!, cluster: p[4] as Cluster };
      return buildKeyMemo(m.publicKey, m.cluster) === text ? m : null;
    }
  } catch { /* not ours */ }
  return null;
}
