'use client';

/**
 * /verify/[lotId]: every bid's signature check, the hash recomputed here, the hash our server reports and the memo read from the
 * settlement transaction on the chain. The chain read is the browser's own (public RPC of the settlement's cluster).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { Cluster } from '@/contracts';
import { normalizeCluster } from '@/lib/auth/config';
import { USDC_DECIMALS } from '@/lib/chain/config';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/chain/explorer';
import { formatUnits, type ChainFacts, type ChainState, type Deployment } from '@/lib/verify/chain';
import LotOrderProof from '@/components/vrf/LotOrderProof';
import VerifyHead from '@/components/verify/VerifyHead';
import StatePanel, { SP_ALT, SP_PRIMARY } from '@/components/ui/StatePanel';
import Term from '@/components/glossary/Term';
import { DemoBadge, DemoNote } from './DemoBadge';
import { fetchVerifyData, settlementTarget, verifyAll, verifyOnChain, type Verified, type VerifyData } from './verifyData';
import './room.css';

// Literal `process.env.NEXT_PUBLIC_*` reads so Next inlines them. No key ever reaches the browser.
const DEPLOYMENT: Deployment = {
  cluster: normalizeCluster(process.env.NEXT_PUBLIC_SOLANA_NETWORK),
  rpcPublic: process.env.NEXT_PUBLIC_SOLANA_RPC_PUBLIC,
  usdcMint: process.env.NEXT_PUBLIC_USDC_MINT,
};

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'ready'; data: VerifyData; result: Verified };
/** 'checking' while the chain is being read; null when the lot has no settlement. */
export type ChainView = 'checking' | ChainState | null;

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const utc = (unixSeconds: number) => `${new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

/** `known` is false when the server already found no such lot: the page then says so without asking the API (a 404 there would show in the console). */
export default function VerifyLot({ lotId, locale, known = true }: { lotId: string; locale: string; known?: boolean }) {
  const t = useTranslations('settlement');
  const [state, setState] = useState<State>(known ? { kind: 'loading' } : { kind: 'missing' });
  const [chain, setChain] = useState<ChainView>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!known) return undefined;
    let live = true;
    (async () => {
      try {
        const data = await fetchVerifyData(lotId);
        if (!live) return;
        if (!data) { setState({ kind: 'missing' }); return; }
        const result = await verifyAll(data);
        if (live) setState({ kind: 'ready', data, result });
      } catch {
        if (live) setState({ kind: 'missing' });
      }
    })();
    return () => { live = false; };
  }, [lotId, known]);

  // The chain read starts once the bids are in, and again on "Check again".
  const ready = state.kind === 'ready' ? state : null;
  useEffect(() => {
    if (!ready?.data.settlement) { setChain(null); return undefined; }
    let live = true;
    setChain('checking');
    verifyOnChain(ready.data, ready.result.recomputed, DEPLOYMENT).then((s) => { if (live) setChain(s); });
    return () => { live = false; };
  }, [ready, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <div className="hp hp-verify" data-testid="verify-page">
      <VerifyHead kicker={t('verify.kicker')} title={t('verify.title')} lede={t('verify.lede')} />
      {state.kind === 'loading' && <p role="status">{t('verify.loading')}</p>}
      {state.kind === 'missing' && (
        <StatePanel variant="compact" role="alert" testId="verify-missing" kicker={t('verify.missingKicker')} title={t('verify.unavailable')} actions={<>
          <Link href={`/${locale}/rooms`} className={SP_PRIMARY}>{t('verify.rooms')}</Link>
          <Link href={`/${locale}`} className={SP_ALT}>{t('verify.home')}</Link>
        </>} />
      )}
      {ready && <VerifyView data={ready.data} result={ready.result} chain={chain} locale={locale} deployment={DEPLOYMENT} onRetry={retry} />}
      {ready && <LotOrderProof showId={ready.data.lot.showId} locale={locale} />}
    </div>
  );
}

/** The loaded page, as a pure function of its inputs (rendered by the component test in every state). */
export function VerifyView({ data, result, chain, locale, deployment, onRetry }: {
  data: VerifyData; result: Verified; chain: ChainView; locale: string; deployment: Deployment; onRetry: () => void;
}) {
  const t = useTranslations('settlement');
  const settlement = data.settlement;
  const target = settlementTarget(data, deployment);
  const facts = chain && chain !== 'checking' && 'facts' in chain ? chain.facts : null;
  const memoHash = facts?.memo.kind === 'ok' ? facts.memo.hash : null;
  const mark = (kind: 'ok' | 'bad' | 'none') => (
    <span className={kind === 'ok' ? 'hp-ok' : kind === 'bad' ? 'hp-bad' : 'hp-warn'} data-mark={kind}>
      <span aria-hidden="true">{kind === 'ok' ? '✓ ' : kind === 'bad' ? '✗ ' : ''}</span>{t(`verify.mark.${kind}`)}
    </span>
  );

  let verdict: { state: string; tone: 'ok' | 'bad' | 'warn'; text: string };
  if (!settlement) verdict = { state: 'no_settlement', tone: 'warn', text: t('verify.noSettlement') };
  else if (chain === 'checking' || chain === null) verdict = { state: 'checking', tone: 'warn', text: t('verify.state.checking') };
  else if (chain.kind === 'confirmed') verdict = { state: 'confirmed', tone: 'ok', text: t('verify.state.confirmed') };
  else if (chain.kind === 'contradicts') {
    const found = chain.facts.memo.kind === 'ok' ? chain.facts.memo.settlementId : '';
    verdict = { state: 'contradicts', tone: 'bad', text: t(`verify.state.contradicts.${chain.why}`, { found, expected: settlement.id }) };
  } else if (chain.kind === 'not_found') verdict = { state: 'not_found', tone: 'warn', text: t(`verify.state.notFound.${chain.why}`) };
  else verdict = { state: 'unreachable', tone: 'warn', text: t('verify.state.unreachable') };
  const canRetry = chain !== null && chain !== 'checking' && (chain.kind === 'unreachable' || (chain.kind === 'not_found' && chain.why !== 'no_signature'));

  return (
    <>
      {data.lot.isHouse && <DemoNote />}
      <h2>{t('verify.lot', { number: String(data.lot.number).padStart(2, '0'), name: data.lot.name })}{data.lot.isHouse && <> <DemoBadge /></>}</h2>
      <div className="hp-verify-table" role="region" tabIndex={0} aria-label={t('verify.bids')}>
        <table>
          <thead>
            <tr>
              <th scope="col"><Term id="paddle">{t('verify.colPaddle')}</Term></th><th scope="col">{t('verify.colAmount')}</th><th scope="col">{t('verify.colTime')}</th>
              <th scope="col">{t('verify.colSigner')}</th><th scope="col">{t('verify.colCheck')}</th>
            </tr>
          </thead>
          <tbody>
            {data.bids.map((b) => {
              const check = result.checks.get(b.id) ?? 'bad_signature';
              return (
                <tr key={b.id} data-testid="verify-bid" data-check={check}>
                  <td data-label={t('verify.colPaddle')}>{b.paddle ?? t('verify.anonymous')}</td>
                  <td data-label={t('verify.colAmount')}>{formatUnits(b.amount, USDC_DECIMALS)} USDC</td>
                  <td data-label={t('verify.colTime')}><time dateTime={b.placedAt}>{new Date(b.placedAt).toISOString().slice(11, 19)} UTC</time></td>
                  <td data-label={t('verify.colSigner')}>{t(b.signer === 'wallet' ? 'verify.signerWallet' : 'verify.signerSession')}</td>
                  <td data-label={t('verify.colCheck')} className={check === 'valid' ? 'hp-ok' : 'hp-bad'}>{t(`verify.check.${check}`)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <dl className="hp-verify-hash">
        <dt>{t('verify.recomputed')}</dt>
        <dd><code data-testid="verify-recomputed">{result.recomputed}</code></dd>
        {settlement && (
          <>
            <dt>{t('verify.api')}</dt>
            <dd><code data-testid="verify-api">{settlement.bidLogHash}</code> {mark(result.match ? 'ok' : 'bad')}</dd>
            <dt><Term id="onChain">{t('verify.onchain')}</Term></dt>
            <dd>
              {memoHash
                ? <><code data-testid="verify-onchain">{memoHash}</code> {mark(memoHash === result.recomputed ? 'ok' : 'bad')}</>
                : <>{facts && <span data-testid="verify-onchain-none">{t('verify.noMemo')} </span>}{mark('none')}</>}
            </dd>
          </>
        )}
      </dl>

      <p role="status" data-testid="verify-result" data-state={verdict.state} className={`hp-verify-verdict is-${verdict.tone}`}>{verdict.text}</p>
      {canRetry && <p><button type="button" className="hp-verify-retry" data-testid="verify-retry" onClick={onRetry}>{t('verify.state.retry')}</button></p>}
      <p className="hp-verify-how">{t('verify.howHash')}</p>
      {settlement && <p className="hp-verify-how">{t('verify.howChain')}</p>}

      {facts && target && <ChainFactsView facts={facts} cluster={target.cluster} />}
      {settlement?.txSignature && target && (
        <p><a className="hp-inline-link" data-testid="verify-explorer" href={explorerTxUrl(settlement.txSignature, target.cluster)} target="_blank" rel="noopener noreferrer">{t('verify.explorer')}</a></p>
      )}
      <p><Link className="hp-inline-link" href={`/${locale}/room/${data.lot.showId}`}>{t('verify.back')}</Link></p>
    </>
  );
}

/** Signature, slot, confirmation level, signers and what moved, all read from the finalized transaction itself. */
function ChainFactsView({ facts, cluster }: { facts: ChainFacts; cluster: Cluster }) {
  const t = useTranslations('settlement');
  const roleOf = (address: string) => facts.signers.find((s) => s.address === address)?.role;
  const party = (address: string) => {
    const role = roleOf(address);
    const label = role === 'buyer' || role === 'seller' ? t(`roles.${role}`) : role === 'fee_payer' ? t('verify.chain.role.fee_payer') : null;
    return <>{label ? `${label} ` : ''}<a href={explorerAddressUrl(address, cluster)} target="_blank" rel="noopener noreferrer"><code>{short(address)}</code></a></>;
  };
  const memoText = facts.memo.kind === 'ok' || facts.memo.kind === 'malformed' ? facts.memo.text : null;
  return (
    <>
      <h2>{t('verify.chain.heading')}</h2>
      <dl className="hp-verify-hash" data-testid="verify-chain-facts">
        <dt>{t('verify.chain.network')}</dt><dd data-testid="verify-network">{t(`verify.chain.net.${cluster}`)}</dd>
        <dt><Term id="signature">{t('verify.chain.signature')}</Term></dt><dd><code data-testid="verify-signature">{facts.signature}</code></dd>
        <dt>{t('verify.chain.slot')}</dt><dd data-testid="verify-slot">{facts.slot}</dd>
        <dt>{t('verify.chain.confirmation')}</dt><dd data-testid="verify-commitment">{t('verify.chain.finalized')}</dd>
        {facts.blockTime !== null && <><dt>{t('verify.chain.time')}</dt><dd>{utc(facts.blockTime)}</dd></>}
        <dt>{t('verify.chain.signers')}</dt>
        <dd>
          <ul data-testid="verify-signers">
            {facts.signers.map((s) => (
              <li key={s.address} data-role={s.role}>{t(`verify.chain.role.${s.role}`)} <a href={explorerAddressUrl(s.address, cluster)} target="_blank" rel="noopener noreferrer"><code>{short(s.address)}</code></a></li>
            ))}
          </ul>
        </dd>
        {memoText && <><dt><Term id="memo">{t('verify.chain.memo')}</Term></dt><dd><code data-testid="verify-memo-text">{memoText}</code></dd></>}
      </dl>
      {(facts.usdc.length > 0 || facts.card) && (
        <div className="hp-verify-table" role="region" tabIndex={0} aria-label={t('verify.chain.moves')}>
          <table data-testid="verify-moves">
            <thead>
              <tr><th scope="col">{t('verify.chain.colWhat')}</th><th scope="col">{t('verify.chain.colFrom')}</th><th scope="col">{t('verify.chain.colTo')}</th></tr>
            </thead>
            <tbody>
              {facts.usdc.map((m, i) => {
                const amount = formatUnits(m.amount, m.decimals);
                return (
                  <tr key={`usdc-${i}`} data-testid="verify-move-usdc">
                    <td data-label={t('verify.chain.colWhat')}>{m.isUsdc ? t('verify.chain.usdc', { amount }) : t('verify.chain.token', { amount, mint: short(m.mint) })}</td>
                    <td data-label={t('verify.chain.colFrom')}>{party(m.from)}</td><td data-label={t('verify.chain.colTo')}>{party(m.to)}</td>
                  </tr>
                );
              })}
              {facts.card && (
                <tr data-testid="verify-move-card">
                  <td data-label={t('verify.chain.colWhat')}>{t('verify.chain.card', { asset: short(facts.card.asset) })}</td><td data-label={t('verify.chain.colFrom')}>{party(facts.card.from)}</td><td data-label={t('verify.chain.colTo')}>{party(facts.card.to)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
