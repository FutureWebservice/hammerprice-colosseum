'use client';

import type { PackView } from '@/contracts';
import { Link } from '@/lib/i18n';
import { shortAddress } from './format';
import { usePackT } from './usePackT';

/**
 * The one compact line the law needs next to a pack: 18+, who the seller (the counterparty) is, the delivery deadline and that odds and pool are public,
 * plus the single link to the explainer. Everything else about how packs work lives behind that link instead of being repeated on every screen.
 */
export default function PackNotice({ pack }: { pack: Pick<PackView, 'mode' | 'operator' | 'operatorRecord'> }) {
  const t = usePackT();
  const r = pack.operatorRecord;
  const record = r && (r.delivered > 0 || r.undelivered > 0) ? t('notice.record', { delivered: r.delivered, undelivered: r.undelivered }) : t('notice.recordNone');
  const seller = shortAddress(pack.operator.wallet);
  const key = pack.operator.isHouse ? 'notice.house' : pack.mode === 'equal_value' ? 'notice.equal' : 'notice.chance';
  return (
    <p className="pk-notice" data-testid="pack-notice">
      {t(key, { seller, record })} <Link href="/packs#how">{t('list.how')}</Link>
    </p>
  );
}
