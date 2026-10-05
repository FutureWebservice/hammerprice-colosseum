import type { Cluster } from '@/contracts';
import type { KeyInfo } from './client';
import CopyButton from './CopyButton';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/chain/explorer';
import type { VrfT } from './text';

/** The key behind every draw: its address (the VRF public key), the transaction that announced it and the counters. */
export default function KeyCard({ publicKey, cluster, info, t }: { publicKey: string; cluster: Cluster; info: KeyInfo | null; t: VrfT }) {
  const sameKey = info?.publicKey === publicKey;
  return (
    <div className="vrf-key" data-testid="vrf-keycard">
      <h2>{t('keycard.title')}</h2>
      <code data-testid="vrf-public-key">{publicKey}</code>
      <p className="vrf-row"><CopyButton value={publicKey} t={t} /> <a className="hp-inline-link" href={explorerAddressUrl(publicKey, cluster)} target="_blank" rel="noopener noreferrer">{t('fields.explorer')}</a></p>
      <p className="vrf-check-how">{t('keycard.algorithm')}</p>
      {info && sameKey && (
        <>
          <p data-testid="vrf-stats">{t('keycard.stats', info.stats)}</p>
          {info.registrationTx
            ? <p>{t('keycard.announced')}: <a className="hp-inline-link" href={explorerTxUrl(info.registrationTx, cluster)} target="_blank" rel="noopener noreferrer"><code>{info.registrationTx.slice(0, 12)}…</code></a></p>
            : <p>{t('keycard.notAnnounced')}</p>}
        </>
      )}
      <p className="vrf-check-how">{t('keycard.hint')}</p>
    </div>
  );
}
