'use client';

/**
 * /verify/packs/[id]: the proof of one opening. The browser loads the public draw, the pack with its whole pool and the public log, then runs
 * the rules itself (lib/packs/verify.ts): "proven" appears only when every cryptographic rule passed here. Nothing depends on trusting the server.
 */
import { useEffect, useState } from 'react';
import { Link } from '@/lib/i18n';
import { normalizeCluster } from '@/lib/auth/config';
import { explorerTxUrl } from '@/lib/chain/explorer';
import { fetchProofBundle, type ProofBundle } from '@/lib/packs/client';
import type { PackCheck } from '@/lib/packs/verify';
import { chainTarget } from '@/lib/verify/chain';
import PackState from './PackState';
import { shortAddress } from './format';
import { usePackT } from './usePackT';
import './packs.css';

const DEPLOYMENT = {
  cluster: normalizeCluster(process.env.NEXT_PUBLIC_SOLANA_NETWORK),
  rpcPublic: process.env.NEXT_PUBLIC_SOLANA_RPC_PUBLIC,
  usdcMint: process.env.NEXT_PUBLIC_USDC_MINT,
};
const MARK: Record<PackCheck['status'], string> = { pass: '✓', fail: '✕', skipped: '○', unverifiable: '?' };

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'ready'; bundle: ProofBundle; checks: PackCheck[]; proven: boolean };

export default function ProofView({ drawId, locale }: { drawId: string; locale: 'de' | 'en' }) {
  const t = usePackT();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const bundle = await fetchProofBundle(drawId);
        if (!bundle) { if (!stopped) setState({ kind: 'missing' }); return; }
        const [{ verifyPackDraw, isPackProven }, { createFetchRpc }] = await Promise.all([import('@/lib/packs/verify'), import('@/lib/vrf/rpc')]);
        const rpc = createFetchRpc(chainTarget(bundle.draw.cluster, DEPLOYMENT).rpcUrl);
        const checks = await verifyPackDraw(bundle.pool, bundle.proofDraw, { earlier: bundle.earlier, rpc });
        if (!stopped) setState({ kind: 'ready', bundle, checks, proven: isPackProven(checks) && !checks.some((c) => c.status === 'fail') });
      } catch {
        if (!stopped) setState({ kind: 'missing' });
      }
    })();
    return () => { stopped = true; };
  }, [drawId]);

  const head = (
    <header className="pk-head">
      <div className="hp-rule" />
      <p className="hp-kicker">{t('proof.kicker')}</p>
      <h1 className="hp-h1">{t('proof.title')}</h1>
      <p className="pk-lede">{t('proof.lede')}</p>
    </header>
  );
  if (state.kind === 'loading') return <div className="hp pk">{head}<div className="pk-wrap"><p className="pk-state" role="status">{t('proof.loading')}</p></div></div>;
  if (state.kind === 'missing') return <div className="hp pk">{head}<div className="pk-wrap"><PackState kind="proofMissing" title={t('proof.missing')} testId="proof-missing" catalogue /></div></div>;

  const { bundle, checks, proven } = state;
  const { draw, detail, proofDraw } = bundle;
  const hidden = !draw.revealed;
  const tierLabel = detail.pack.odds.find((o) => o.tier === draw.tier)?.label[locale] ?? draw.tier ?? '';
  const beacon = draw.vrf.beacon;
  return (
    <div className="hp pk" data-testid="proof-page" data-proven={proven ? 'true' : 'false'}>
      {head}
      <div className="pk-wrap">
        {hidden ? (
          <p className="pk-verdict" data-testid="proof-hidden"><span>{t('proof.hidden')}</span></p>
        ) : (
          <div className={`pk-verdict ${proven ? 'pk-verdict--ok' : 'pk-verdict--bad'}`} data-testid="proof-verdict" role="status">
            <h2>{proven ? t('proof.proven') : t('proof.notProven')}</h2>
            <p>{proven ? t('proof.provenBody') : t('proof.notProvenBody')}</p>
          </div>
        )}
        <section className="pk-section">
          <h2>{draw.drawIndex === null ? t('proof.summaryPending', { pack: detail.pack.name[locale] }) : t('proof.summary', { n: draw.drawIndex + 1, pack: detail.pack.name[locale] })}</h2>
          <dl className="pk-facts">
            <div className="pk-fact"><dt>{t('proof.pack')}</dt><dd><Link className="pk-link" href={`/packs/${detail.pack.id}`}>{detail.pack.name[locale]}</Link></dd></div>
            <div className="pk-fact"><dt>{t('proof.buyer')}</dt><dd className="pk-mono">{shortAddress(draw.buyer)}</dd></div>
            {draw.card && <div className="pk-fact"><dt>{t('proof.result')}</dt><dd>{t('proof.tierLine', { tier: tierLabel, card: draw.card.name })}</dd></div>}
            {draw.txSignature && <div className="pk-fact"><dt>{t('proof.payment')}</dt><dd><a className="pk-link" href={explorerTxUrl(draw.txSignature, draw.cluster)} target="_blank" rel="noopener noreferrer">{shortAddress(draw.txSignature)}</a></dd></div>}
            {draw.operator && <div className="pk-fact"><dt>{t('proof.operator')}</dt><dd className="pk-mono">{shortAddress(draw.operator.wallet)}</dd></div>}
            {draw.deliverySignature && <div className="pk-fact"><dt>{t('proof.delivery')}</dt><dd><a className="pk-link" href={explorerTxUrl(draw.deliverySignature, draw.cluster)} target="_blank" rel="noopener noreferrer">{shortAddress(draw.deliverySignature)}</a></dd></div>}
            {draw.flow === 'pay_first' && <div className="pk-fact"><dt>{t('proof.flow')}</dt><dd>{t('proof.flowPayFirst')}</dd></div>}
            <div className="pk-fact"><dt>{t('proof.seed')}</dt><dd className="pk-mono" style={{ wordBreak: 'break-all' }}>{draw.clientSeed}</dd></div>
            {beacon && <div className="pk-fact"><dt>{t('proof.beacon')}</dt><dd className="pk-mono">{beacon.slot}</dd></div>}
          </dl>
        </section>
        <section className="pk-section">
          <h2>{t('proof.checks')}</h2>
          <ul className="pk-checks" data-testid="proof-checks">
            {checks.map((c) => (
              <li key={c.id} data-status={c.status} data-check={c.id}>
                <span className="pk-check-mark" aria-hidden="true">{MARK[c.status]}</span>
                <span className="pk-check-title">{t(`proof.rule.${c.id}`)}<span className="pk-check-state">{t(`proof.${c.status}`)}</span></span>
                <span className="pk-check-desc">{t(`proof.rule.${c.id}_d`)}{c.detail && c.status !== 'pass' ? ` (${c.detail})` : ''}</span>
              </li>
            ))}
          </ul>
        </section>
        {!hidden && (
          <section className="pk-section pk-raw">
            <h2>{t('proof.raw')}</h2>
            <details><summary>{t('proof.input')}</summary><pre>{draw.vrf.input}</pre></details>
            <details><summary>{t('proof.proofHex')}</summary><pre>{draw.vrf.proofHex}</pre></details>
            <details><summary>{t('proof.outputHex')}</summary><pre>{draw.vrf.outputHex}</pre></details>
            <details><summary>{t('proof.params')}</summary><pre>{JSON.stringify(proofDraw.vrf.params, null, 2)}</pre></details>
          </section>
        )}
        <section className="pk-section">
          <h2>{t('proof.limits')}</h2>
          <ul className="pk-limits"><li>{t('proof.limit1')}</li><li>{t('proof.limit2')}</li><li>{t('proof.limit3')}</li><li>{t('proof.limit4')}</li><li>{t('proof.limit5')}</li></ul>
        </section>
      </div>
    </div>
  );
}
