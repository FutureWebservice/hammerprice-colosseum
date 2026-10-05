'use client';

import { useEffect, useState } from 'react';
import type { PackDrawView } from '@/contracts';
import { Link } from '@/lib/i18n';
import { getDraws } from './api';
import { shortAddress } from './format';
import { usePackT } from './usePackT';

/** The public log of this pack's openings, newest first: who, what came out (once paid) and a link to the proof. */
export default function DrawLog({ packId, refreshKey, tierLabel }: { packId: string; refreshKey?: string; tierLabel: Record<string, string> }) {
  const t = usePackT();
  const [draws, setDraws] = useState<PackDrawView[] | null>(null);
  useEffect(() => {
    let stopped = false;
    void getDraws(packId, 10).then((r) => { if (!stopped) setDraws(r.ok ? r.data.draws : []); });
    return () => { stopped = true; };
  }, [packId, refreshKey]);
  if (draws === null) return <p className="pk-state">{t('loading')}</p>;
  if (draws.length === 0) return <p className="pk-note" data-testid="log-empty">{t('log.empty')}</p>;
  return (
    <ul className="pk-log" data-testid="draw-log">
      {draws.map((d) => (
        <li key={d.id}>
          <span><span className="pk-mono">{t('log.number', { n: (d.drawIndex ?? 0) + 1 })}</span> <span className="who">{t('log.by', { address: shortAddress(d.buyer) })}</span></span>
          <span className="res">
            {d.card && d.status !== 'undelivered' ? `${d.card.name} (${tierLabel[d.card.tier] ?? d.card.tier})`
              : <span className="dim">{d.status === 'undelivered' ? t('log.undelivered') : d.status === 'reserved' || d.status === 'submitted' || d.status === 'awaiting_payment' || d.status === 'confirming' ? t('log.pending') : ['paid', 'drawn', 'delivering'].includes(d.status) ? t('log.delivering') : t('log.expired')}</span>}
          </span>
          {d.revealed && <Link className="pk-link" href={`/verify/packs/${d.id}`}>{t('log.proof')}</Link>}
        </li>
      ))}
    </ul>
  );
}
