/**
 * The glossary's ids and which of them exist on which network. The words themselves live in glossary.json.
 * Terms about the test network are not offered on mainnet: there is nothing to explain, and the text would be wrong.
 */
import type { Cluster } from '@/contracts';

export const GLOSSARY_IDS = [
  'usdc', 'devnet', 'wallet', 'signature', 'paddle', 'bid', 'reserve', 'hammer', 'hammerPrice', 'antiSniping',
  'networkFee', 'onChain', 'transaction', 'settlement', 'memo', 'verify', 'ecvrf', 'testUsdc', 'replica',
] as const;
export type GlossaryId = (typeof GLOSSARY_IDS)[number];

export const DEVNET_ONLY: readonly GlossaryId[] = ['devnet', 'testUsdc', 'replica'];

export const isGlossaryId = (v: string): v is GlossaryId => (GLOSSARY_IDS as readonly string[]).includes(v);

export function visibleTermIds(cluster: Cluster): GlossaryId[] {
  return GLOSSARY_IDS.filter((id) => cluster !== 'mainnet-beta' || !DEVNET_ONLY.includes(id));
}

/** Longest sentence a term may have. */
export const TERM_MAX_CHARS = 140;
