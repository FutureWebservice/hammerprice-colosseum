import './verify.css';

/** The head of a verify or proof page: brass rule, kicker, big serif headline, one plain sentence of what the page does. */
export default function VerifyHead({ kicker, title, lede }: { kicker: string; title: string; lede: string }) {
  return (
    <header className="vf-head">
      <div className="vf-rule" aria-hidden="true" />
      <p className="vf-kicker">{kicker}</p>
      <h1>{title}</h1>
      <p className="vf-lede hp-verify-lede">{lede}</p>
    </header>
  );
}
