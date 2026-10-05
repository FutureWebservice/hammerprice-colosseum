import { useTranslations } from 'next-intl';
import type { Cluster } from '@/contracts';
import { clientCluster, textKey } from '@/lib/client/cluster-text';

export type VrfT = (key: string, values?: Record<string, string | number>) => string;

/** Translator of the `vrf` namespace that takes the `Main` sibling of a text on mainnet (the same rule as every network-dependent text). */
export function useVrfT(cluster: Cluster = clientCluster()): VrfT {
  const t = useTranslations('vrf');
  const loose = t as unknown as ((k: string, v?: Record<string, string | number>) => string) & { has: (k: string) => boolean };
  return (key, values) => loose(textKey(key, cluster, loose.has), values);
}
