'use client';

import type { PackDrawView } from '@/contracts';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/chain/explorer';
import { Link } from '@/lib/i18n';
import { shortAddress } from './format';
import { usePackT } from './usePackT';

const REASONS = ['deadline', 'asset_moved', 'asset_not_transferable', 'pool_empty'];

/**
 * The operator did not deliver. Hammerprice never held the payment and cannot return it, so this screen says so plainly and hands the buyer what they need to
 * claim against the operator: the operator wallet, the payment, and the proof of the draw. Nothing here is a card reveal.
 */
export default function Undelivered({ draw, onBack }: { draw: PackDrawView; onBack: () => void }) {
  const t = usePackT();
  const reason = draw.undeliveredReason && REASONS.includes(draw.undeliveredReason) ? draw.undeliveredReason : 'deadline';
  return (
    <div className="pk-result" data-testid="undelivered">
      <h3>{t('undelivered.title')}</h3>
      <p>{t('undelivered.body')}</p>
      <p className="pk-note" style={{ margin: 0 }}>{t(`undelivered.reason.${reason}`)}</p>
      {reason === 'deadline' && <p className="pk-note" style={{ margin: 0 }}>{t('undelivered.late')}</p>}
      <dl className="pk-review">
        {draw.operator && <div><dt>{t('undelivered.operator')}</dt><dd><a className="pk-link" href={explorerAddressUrl(draw.operator.wallet, draw.cluster)} target="_blank" rel="noopener noreferrer" data-testid="undelivered-operator">{shortAddress(draw.operator.wallet)}</a></dd></div>}
        {draw.txSignature && <div><dt>{t('undelivered.payment')}</dt><dd><a className="pk-link" href={explorerTxUrl(draw.txSignature, draw.cluster)} target="_blank" rel="noopener noreferrer">{shortAddress(draw.txSignature)}</a></dd></div>}
      </dl>
      <div className="pk-tools">
        {draw.vrf.requestId && <Link className="pk-link" href={`/verify/packs/${draw.id}`}>{t('undelivered.proof')}</Link>}
        <button type="button" className="pk-btn" onClick={onBack} data-testid="undelivered-back">{t('undelivered.back')}</button>
      </div>
    </div>
  );
}
