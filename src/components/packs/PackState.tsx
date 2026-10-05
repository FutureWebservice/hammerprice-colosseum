'use client';

/** An empty, failed or missing state of a packs page: the shared StatePanel with the packs wording and the ways on (the catalogue where it makes sense, the rooms, home). */
import type { ReactNode } from 'react';
import { Link } from '@/lib/i18n';
import StatePanel, { SP_ALT, SP_PRIMARY } from '@/components/ui/StatePanel';
import { usePackT } from './usePackT';

export type PackStateKind = 'empty' | 'error' | 'unavailable' | 'notFound' | 'proofMissing';

export default function PackState({ kind, title, testId, retry, catalogue = false }: { kind: PackStateKind; title: string; testId?: string; retry?: ReactNode; catalogue?: boolean }) {
  const t = usePackT();
  return (
    <StatePanel
      variant="compact" role={kind === 'empty' ? 'status' : 'alert'} testId={testId}
      kicker={t(`states.${kind}Kicker`)} title={title}
      actions={<>
        {retry}
        {catalogue && <Link href="/packs" className={retry ? SP_ALT : SP_PRIMARY}>{t('states.catalogue')}</Link>}
        <Link href="/rooms" className={retry || catalogue ? SP_ALT : SP_PRIMARY}>{t('states.rooms')}</Link>
        <Link href="/" className={SP_ALT}>{t('states.home')}</Link>
      </>}
    >
      {t(`states.${kind}Body`)}
    </StatePanel>
  );
}
