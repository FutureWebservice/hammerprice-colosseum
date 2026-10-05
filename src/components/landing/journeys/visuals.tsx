/**
 * The small pictures of the journey blocks: plain markup and CSS (journeys.css), no image and no script.
 * Each one mocks a screen the visitor will meet, with example words from landing.json (`journeys.items.<id>.mock`).
 * Decorative: the wrapper in Journeys.tsx is aria-hidden, the steps next to it carry the meaning.
 */
import type { ReactNode } from 'react';

type M = Record<string, string>;

export function BidVisual({ m }: { m: M }) {
  return (
    <div className="hp-m">
      <div className="hp-m-row"><span className="hp-m-dim">{m.lot}</span><span className="hp-m-pill">{m.left}</span></div>
      <div className="hp-m-label">{m.high}</div>
      <div className="hp-m-big">{m.highAmount}</div>
      <div className="hp-m-dim">{m.you}</div>
      <div className="hp-m-btn">{m.button}</div>
      <div className="hp-m-dim hp-m-center">{m.note}</div>
    </div>
  );
}

export function SellVisual({ m }: { m: M }) {
  const steps = [m.s1, m.s2, m.s3, m.s4];
  return (
    <div className="hp-m">
      <ol className="hp-m-steps">
        {steps.map((s, i) => (
          <li key={i} className={i < 3 ? 'is-done' : 'is-now'}><span>{i + 1}</span>{s}</li>
        ))}
      </ol>
      <div className="hp-m-row"><span className="hp-m-dim">{m.length}</span><span className="hp-m-chip">{m.lengthValue}</span></div>
      <div className="hp-m-row"><span className="hp-m-dim">{m.reserve}</span><span className="hp-m-chip">{m.reserveValue}</span></div>
      <div className="hp-m-btn">{m.ready}</div>
    </div>
  );
}

export function ChatVisual({ m }: { m: M }) {
  return (
    <div className="hp-m">
      <div className="hp-m-bubble hp-m-bubble--you">{m.you}<span className="hp-m-sub">{m.waiting}</span></div>
      <div className="hp-m-toast">
        <div className="hp-m-label">{m.toast}</div>
        <div className="hp-m-toast-text"><strong>{m.who}</strong> {m.you}</div>
        <div className="hp-m-btns"><span className="hp-m-btn hp-m-btn--sm">{m.approve}</span><span className="hp-m-btn hp-m-btn--ghost hp-m-btn--sm">{m.reject}</span></div>
      </div>
    </div>
  );
}

export function TelegramVisual({ m }: { m: M }) {
  return (
    <div className="hp-m hp-m--tg">
      <div className="hp-m-bubble hp-m-bubble--bot">
        <strong className="hp-m-bot">{m.bot}</strong>
        <span className="hp-m-head">{m.head}</span>
        <span>{m.card}</span>
        <span className="hp-m-sub">{m.left}</span>
      </div>
      <div className="hp-m-tgbtns">
        <span className="hp-m-tgbtn">{m.bid}</span>
        <span className="hp-m-tgbtn">{m.bidPlus}</span>
      </div>
    </div>
  );
}

export function AgentVisual({ m }: { m: M }) {
  return (
    <div className="hp-m">
      <div className="hp-m-bubble hp-m-bubble--you hp-m-bubble--right">{m.ask}</div>
      <div className="hp-m-bubble hp-m-bubble--bot">{m.answer}</div>
      <div className="hp-m-btns">
        <span className="hp-m-chip">{m.c1}</span><span className="hp-m-chip">{m.c2}</span><span className="hp-m-chip">{m.c3}</span>
      </div>
      <div className="hp-m-dim hp-m-center">{m.confirm}</div>
    </div>
  );
}

export function ProfileVisual({ m }: { m: M }) {
  return (
    <div className="hp-m">
      <div className="hp-m-id">
        <span className="hp-m-avatar">{m.name.charAt(0).toUpperCase()}</span>
        <strong>{m.name}</strong>
      </div>
      <div className="hp-m-balances">
        <div><div className="hp-m-label">{m.usdc}</div><div className="hp-m-big hp-m-big--sm">250.00</div></div>
        <div><div className="hp-m-label">{m.sol}</div><div className="hp-m-big hp-m-big--sm">0.05</div></div>
      </div>
      <div className="hp-m-btns"><span className="hp-m-chip is-on">{m.t1}</span><span className="hp-m-chip">{m.t2}</span><span className="hp-m-chip">{m.t3}</span></div>
      <div className="hp-m-row"><span>{m.row}</span></div>
    </div>
  );
}

/** The sealed pack, its published odds as one stacked bar and the whole card pool as a grid. Plain markup and one inline SVG, no text inside the SVG. */
export function PacksVisual({ m }: { m: M }) {
  const pool = ['c', 'c', 'c', 'c', 'c', 'c', 'c', 'c', 'r', 'r', 'r', 'x']; // 8 common, 3 rare, 1 chase
  return (
    <div className="hp-m hp-m--pk">
      <div className="hp-pk-top">
        <svg className="hp-pk-seal" viewBox="0 0 64 88" width="56" height="77" aria-hidden="true" focusable="false">
          <path className="hp-pk-foil" d="M6 8l4-4 4 4 4-4 4 4 4-4 4 4 4-4 4 4 4-4 4 4 4-4 2 2v72l-2 2-4-4-4 4-4-4-4 4-4-4-4 4-4-4-4 4-4-4-4 4-4-4-4 4-2-2z" />
          <rect className="hp-pk-frame" x="14" y="22" width="36" height="44" rx="3" />
          <path className="hp-pk-star" d="M32 31l3.4 7 7.6 1-5.5 5.3 1.3 7.7-6.8-3.7-6.8 3.7 1.3-7.7-5.5-5.3 7.6-1z" />
        </svg>
        <div className="hp-pk-title">
          <strong>{m.name}</strong>
          <span className="hp-m-dim">{m.sealed}</span>
          <span className="hp-m-pill">{m.price}</span>
        </div>
      </div>
      <div className="hp-m-label">{m.odds}</div>
      <div className="hp-pk-bar">
        <span className="hp-pk-c" style={{ flexGrow: 70 }} />
        <span className="hp-pk-r" style={{ flexGrow: 25 }} />
        <span className="hp-pk-x" style={{ flexGrow: 5 }} />
      </div>
      <ul className="hp-pk-legend">
        <li><i className="hp-pk-c" />{m.t1}</li>
        <li><i className="hp-pk-r" />{m.t2}</li>
        <li><i className="hp-pk-x" />{m.t3}</li>
      </ul>
      <div className="hp-m-label">{m.pool}</div>
      <div className="hp-pk-grid">{pool.map((t, i) => <span key={i} className={`hp-pk-${t}`} />)}</div>
      <div className="hp-m-dim hp-pk-hash">{m.hash}</div>
    </div>
  );
}

/** The peer-to-peer flow: seller wallet, the buyer's direct payment, the draw after the payment is final, the delivery; the platform beside it. */
export function PacksFlow({ f }: { f: M }) {
  const nodes: Array<[string, string]> = [[f.f1, f.f1s], [f.f2, f.f2s], [f.f3, f.f3s], [f.f4, f.f4s]];
  return (
    <div className="hp-jx hp-jflow" aria-hidden="true">
      <div className="hp-m-label">{f.heading}</div>
      <ol className="hp-fl">
        {nodes.map(([t, sub]) => (
          <li key={t} className="hp-fl-node"><strong>{t}</strong><span>{sub}</span></li>
        ))}
      </ol>
      <p className="hp-fl-platform">{f.platform}</p>
    </div>
  );
}

export const JOURNEY_VISUALS: Record<string, (p: { m: M }) => ReactNode> = {
  bid: BidVisual,
  sell: SellVisual,
  packs: PacksVisual,
  chat: ChatVisual,
  telegram: TelegramVisual,
  agent: AgentVisual,
  profile: ProfileVisual,
};
