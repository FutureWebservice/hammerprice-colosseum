/**
 * The VRF key of this deployment, loaded from VRF_SECRET_KEY once per value (parsing checks the key pair, which is slow in pure JS).
 * SERVER ONLY (lib/vrf/key.ts refuses a browser bundle). `null` means "no key": the feature then falls back to catalogue order.
 * The value never leaves this process: nothing here logs it, and a bad value is reported by variable name only.
 */
import { createHash } from 'node:crypto';
import { loadVrfKey, VRF_KEY_ENV, type VrfKey } from '@/lib/vrf/key';

type Env = Record<string, string | undefined>;
let memo: { digest: string; key: VrfKey | null } | null = null;

/** The key, or null when unset or unusable (a startup-grade problem is logged once by name, never by value). */
export function vrfKey(env: Env = process.env): VrfKey | null {
  const raw = env[VRF_KEY_ENV] ?? '';
  const digest = createHash('sha256').update(raw).digest('hex');
  if (memo?.digest === digest) return memo.key;
  let key: VrfKey | null = null;
  try { key = loadVrfKey(env); } catch (e) { console.error(`${VRF_KEY_ENV} is set but unusable: ${(e as { code?: string }).code ?? 'error'}`); }
  memo = { digest, key };
  return key;
}

/** Tests only. */
export const clearVrfKeyMemo = (): void => { memo = null; };
