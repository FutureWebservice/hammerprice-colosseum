import type { Cluster } from '@/contracts';
import { explorerTxUrl } from '@/lib/chain/explorer';
import type { VrfRequestView } from '@/lib/vrf';
import type { VrfT } from './text';

const dash = (t: VrfT) => <span className="hp-dim">{t('fields.none')}</span>;

/** Every public field of one draw, as the verifier reads it: input, beacon, proof, output, result, and the two transactions. */
export default function ProofPanel({ view, names, t }: { view: VrfRequestView; names: Record<string, string>; t: VrfT }) {
  const cluster: Cluster = view.cluster;
  const tx = (sig: string | null) => (sig
    ? <a className="hp-inline-link" href={explorerTxUrl(sig, cluster)} target="_blank" rel="noopener noreferrer"><code className="vrf-long">{sig}</code></a>
    : dash(t));
  const hex = (v: string | null, testid: string) => (v ? <code className="vrf-long" data-testid={testid}>{v}</code> : dash(t));
  return (
    <dl className="hp-verify-hash" data-testid="vrf-proof">
      <dt>{t('fields.status')}</dt><dd data-testid="vrf-status">{t(`status.${view.status}`)}</dd>
      <dt>{t('fields.cluster')}</dt><dd>{t(cluster === 'mainnet-beta' ? 'cluster.mainnet' : 'cluster.devnet')}</dd>
      <dt>{t('fields.committed')}</dt><dd><code className="vrf-long" data-testid="vrf-params-hash">{view.paramsHash}</code></dd>
      <dt>{t('fields.input')}</dt><dd>{view.alphaText ? <pre className="vrf-pre" data-testid="vrf-alpha">{view.alphaText}</pre> : dash(t)}</dd>
      <dt>{t('fields.beacon')}</dt><dd>{view.beacon ? <code className="vrf-long" data-testid="vrf-beacon">{view.beacon.slot}:{view.beacon.blockhash}</code> : dash(t)}</dd>
      <dt>{t('fields.proof')}</dt><dd>{hex(view.proofHex, 'vrf-proof-hex')}</dd>
      <dt>{t('fields.output')}</dt><dd>{hex(view.outputHex, 'vrf-output-hex')}</dd>
      <dt>{t('fields.commitTx')}</dt><dd data-testid="vrf-commit-tx">{tx(view.commitTx)}</dd>
      <dt>{t('fields.revealTx')}</dt><dd data-testid="vrf-reveal-tx">{tx(view.revealTx)}</dd>
      <dt>{t('fields.deadline')}</dt><dd><time dateTime={view.revealBy}>{view.revealBy.slice(0, 19).replace('T', ' ')} UTC</time></dd>
      <dt>{t('fields.result')}</dt>
      <dd><Result view={view} names={names} t={t} /></dd>
    </dl>
  );
}

const label = (id: string, names: Record<string, string>) => names[id] ?? `${id.slice(0, 8)}…`;

/** The lot order before and after, or the drawn paddle; nothing while there is no result. */
export function Result({ view, names, t }: { view: VrfRequestView; names: Record<string, string>; t: VrfT }) {
  const r = view.result as Record<string, unknown> | null;
  if (!r) return dash(t);
  if (view.purpose === 'raffle') {
    const entrants = (r.entrants as number[] | undefined) ?? [];
    return (
      <div data-testid="vrf-raffle">
        <p><strong data-testid="vrf-winner">{t('raffle.winner', { number: String(r.winnerPaddle) })}</strong></p>
        <p>{t('raffle.entrants', { count: entrants.length, list: entrants.join(', ') })}</p>
        <p className="vrf-check-how">{t('raffle.bots')}</p>
      </div>
    );
  }
  const before = ((view.params as { lots?: { id: string; n: number }[] }).lots ?? []).slice().sort((a, b) => a.n - b.n);
  const after = (r.order as string[] | undefined) ?? [];
  return (
    <div data-testid="vrf-order">
      <div className="vrf-lots">
        <div><h3 className="vrf-group">{t('order.before')}</h3><ol data-testid="vrf-order-before">{before.map((l) => <li key={l.id} value={l.n}>{label(l.id, names)}</li>)}</ol></div>
        <div><h3 className="vrf-group">{t('order.after')}</h3><ol data-testid="vrf-order-after">{after.map((id) => <li key={id}>{label(id, names)}</li>)}</ol></div>
      </div>
      <p className="vrf-check-how" data-testid="vrf-applied">{t(r.applied === false ? 'order.notApplied' : 'order.applied')}</p>
    </div>
  );
}
