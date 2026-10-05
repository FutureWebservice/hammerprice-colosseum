'use client';

import type { PackView } from '@/contracts';
import { usePackT } from './usePackT';

/** What was fixed before the first sale: the hashes, the time, the draw key. */
export default function CommitBox({ pack, locale }: { pack: PackView; locale: string }) {
  const t = usePackT();
  const at = pack.commitment.committedAt ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(pack.commitment.committedAt)) + ' UTC' : null;
  return (
    <div className="pk-commit" data-testid="commit-box">
      <p style={{ margin: 0, fontSize: 14, color: '#c9d1cd' }}>{t('commit.body')}</p>
      <dl>
        <div><dt>{t('commit.poolHash')}</dt><dd data-testid="pool-hash">{pack.commitment.poolHash ?? t('commit.none')}</dd></div>
        <div><dt>{t('commit.oddsHash')}</dt><dd>{pack.commitment.oddsHash ?? t('commit.none')}</dd></div>
        <div><dt>{t('commit.committedAt')}</dt><dd>{at ?? t('commit.none')}</dd></div>
        <div><dt>{t('commit.key')}</dt><dd>{pack.vrfPublicKey ?? t('commit.none')}</dd></div>
      </dl>
      <p className="pk-note" style={{ margin: 0 }}>{t('commit.keyNote')}</p>
    </div>
  );
}
