/**
 * One switch for wording that depends on the network. SOLANA_CLUSTER is the single switch (the browser sees it as
 * NEXT_PUBLIC_SOLANA_NETWORK); any text that talks about test money, the test network or replicas has a sibling key
 * with the suffix "Main" that is used on mainnet. A test (ux-copy.test.ts) fails if such a text has no Main sibling
 * or if a Main text still says "test".
 */
import { useTranslations } from 'next-intl';
import { normalizeCluster } from '@/lib/auth/config';
import type { Cluster } from '@/contracts';

export const MAIN_SUFFIX = 'Main';

/** Literal env read so Next inlines it into the client bundle. Anything but mainnet means devnet. */
export const clientCluster = (): Cluster => normalizeCluster(process.env.NEXT_PUBLIC_SOLANA_NETWORK);

/** `key` on devnet, `keyMain` on mainnet when that sibling exists. */
export function textKey(key: string, cluster: Cluster, has: (k: string) => boolean): string {
  return cluster === 'mainnet-beta' && has(key + MAIN_SUFFIX) ? key + MAIN_SUFFIX : key;
}

/** Translator for a namespace that picks the cluster variant. `cluster` defaults to the deployment's. */
export function useClusterT(namespace: 'tour' | 'glossary', cluster: Cluster = clientCluster()) {
  const t = useTranslations(namespace);
  // The key type is a literal union per namespace; the helper deals in plain strings.
  const loose = t as unknown as ((k: string, v?: Record<string, string | number>) => string) & { has: (k: string) => boolean };
  return (key: string, values?: Record<string, string | number>): string => loose(textKey(key, cluster, loose.has), values);
}
