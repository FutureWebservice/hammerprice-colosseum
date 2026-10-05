'use client';

import { useTranslations } from 'next-intl';
import { clientCluster, textKey } from '@/lib/client/cluster-text';

type Loose = ((k: string, v?: Record<string, string | number>) => string) & { has: (k: string) => boolean };

/**
 * Translator for the packs namespace that picks the network's wording: a text that talks about test money or replicas has a sibling with the
 * suffix "Main" that is used on mainnet (the same rule as src/lib/client/cluster-text.ts; a test checks that every such text has its sibling).
 */
export function usePackT() {
  const t = useTranslations('packs') as unknown as Loose;
  const cluster = clientCluster();
  return Object.assign((key: string, values?: Record<string, string | number>): string => t(textKey(key, cluster, t.has), values), { has: t.has, cluster });
}
