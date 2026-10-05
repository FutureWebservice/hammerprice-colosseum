'use client';

import type { Cluster } from '@/contracts';
import { clientCluster, useClusterT } from '@/lib/client/cluster-text';
import { visibleTermIds, type GlossaryId } from './terms';

/** The glossary for this network: ids in order, and the label and sentence of each (the "Main" wording on mainnet). */
export function useGlossary(cluster: Cluster = clientCluster()) {
  const t = useClusterT('glossary', cluster);
  return {
    cluster,
    ids: visibleTermIds(cluster),
    has: (id: string) => (visibleTermIds(cluster) as string[]).includes(id),
    label: (id: GlossaryId) => t(`terms.${id}.label`),
    text: (id: GlossaryId) => t(`terms.${id}.text`),
    title: t('title'),
    close: t('close'),
    listTitle: t('listTitle'),
    faq: t('faq'),
  };
}
