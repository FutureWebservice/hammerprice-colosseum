/**
 * The pitch-formatted parts of /about (it was the page /pitch, which now redirects to /about#pitch), as separate pieces the page
 * composes in its own order: the hero, the image strip (the showcase of device-framed screenshots), the one consolidated
 * function description with the ledger, the verified-randomness section, and the story (problem and solution, the
 * links). Short lines under big headings, glass panels, solid yellow buttons.
 *
 * The live numbers on it are the vault count and the proof link. The page (src/app/[locale]/about/page.tsx) reads them at
 * revalidate time (vault-total.ts, proof-link.ts) and passes them in, so these stay plain components: a figure a reader can
 * check is worth more than one they have to believe.
 */
import Logo from '@/components/brand/Logo';
import { getPitchMessages } from './content';
import Go from './Go';
import { type Locale } from '@/lib/i18n';
import { IDEATHON_LINE } from '@/components/landing/site';
import './pitch.css';

const no = (i: number) => String(i + 1).padStart(2, '0');

export function PitchHero({ locale, kicker }: { locale: Locale; kicker: string }) {
  const m = getPitchMessages(locale);
  return (
    <header className="pt-bill">
      <Logo className="pt-bill-logo" alt="Hammerprice" />
      <p className="pt-eyebrow">{kicker} · {m.eyebrow}</p>
      <h1>
        {m.headline.before}
        <em>{m.headline.em}</em>
        {m.headline.after}
      </h1>
      <p className="pt-tagline">{m.tagline}</p>
      <div className="pt-bill-ctas">
        <Go href="/room/house" locale={locale} className="pt-cta">{m.cta.room}</Go>
        <Go href="/sell" locale={locale} className="pt-cta pt-cta--ghost">{m.cta.sell}</Go>
        <Go href="#verify" locale={locale} className="pt-cta pt-cta--ghost">{m.cta.verify}</Go>
      </div>
      {/* The owner's exact wording: never a rank, never "won", nothing quoted from the jury. */}
      <p className="pt-badge">{IDEATHON_LINE[locale]}</p>
      <div className="pt-credits">
        {/* The form takes one link. Whoever opens it in the wrong language gets one word out rather than having to find the switcher in the header. */}
        <Go className="pt-lang" href="/about" locale={locale === 'de' ? 'en' : 'de'}>{m.langSwitch}</Go>
      </div>
    </header>
  );
}

export function PitchShowcase({ locale }: { locale: Locale }) {
  const m = getPitchMessages(locale).showcase;
  return (
    <section className="pt-sec pt-showcase" id="screens" aria-labelledby="pt-showcase-h">
      <p className="pt-kicker">{m.kicker}</p>
      <h2 id="pt-showcase-h">{m.heading}</h2>
      <p className="pt-showcase-intro">{m.intro}</p>
      <ol className="pt-shots">
        {m.items.map((s) => (
          <li className={`pt-shot pt-shot--${s.frame}`} key={s.id} data-shot={s.id}>
            <div className="pt-shot-text">
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
            <figure className="pt-device">
              <div className="pt-frame">
                <div className="pt-frame-bar" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.src} alt={s.alt} width={s.width} height={s.height} loading="lazy" decoding="async" />
              </div>
            </figure>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function PitchFeatures({ locale, total }: { locale: Locale; total: string }) {
  const m = getPitchMessages(locale);
  return (
    <section className="pt-sec" id="features" aria-labelledby="pt-features-h">
      <p className="pt-kicker">{m.features.kicker}</p>
      <h2 id="pt-features-h">{m.features.heading}</h2>
      <p className="pt-lede">{m.features.intro}</p>
      <ul className="pt-grid">
        {m.features.items.map((f, i) => (
          <li key={f.title} className="pt-feature pt-glass">
            <span className="pt-feature-no" aria-hidden="true">{no(i)}</span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
            {f.link && <Go href={f.link.href} locale={locale} className="pt-textlink">{f.link.label}</Go>}
          </li>
        ))}
      </ul>

      <dl className="pt-ledger">
        <div>
          <dt>{m.ledgerLabels.vault}</dt>
          <dd>{total}</dd>
        </div>
        <div>
          <dt>{m.ledgerLabels.commission}</dt>
          <dd>{m.ledgerLabels.commissionValue}<span>%</span></dd>
        </div>
        <div>
          <dt>{m.ledgerLabels.premium}</dt>
          <dd>{m.ledgerLabels.premiumValue}<span>%</span></dd>
        </div>
        <div>
          <dt>{m.ledgerLabels.custody}</dt>
          <dd>0</dd>
        </div>
      </dl>
    </section>
  );
}

/** Verified randomness: what it is in three sentences, how a visitor checks it, and the live proof of the house room. `proofHref` is
 *  `/verify/random/<id>` of the newest drawn house lot order (proof-link.ts), or null when none is available: then the button opens the room. */
export function PitchVerify({ locale, proofHref }: { locale: Locale; proofHref: string | null }) {
  const m = getPitchMessages(locale).verify;
  return (
    <section className="pt-sec" id="verify" aria-labelledby="pt-verify-h">
      <p className="pt-kicker">{m.kicker}</p>
      <h2 id="pt-verify-h">{m.heading}</h2>
      <div className="pt-verify">
        <div className="pt-glass pt-verify-main">
          <p className="pt-verify-what">{m.what}</p>
          <h3>{m.howHeading}</h3>
          <ol className="pt-verify-steps">
            {m.steps.map((s, i) => (
              <li key={s}>
                <span className="pt-step-no">{no(i)}</span>
                <p>{s}</p>
              </li>
            ))}
          </ol>
          <ul className="pt-verify-also">
            {m.also.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
        <aside className="pt-glass pt-verify-live" aria-labelledby="pt-verify-live-h" data-testid="verify-live">
          <h3 id="pt-verify-live-h">{m.live.heading}</h3>
          <p>{proofHref ? m.live.body : m.live.fallbackBody}</p>
          <div className="pt-bill-ctas">
            <Go href={proofHref ?? '/room/house'} locale={locale} className="pt-cta">{proofHref ? m.live.cta : m.live.ctaFallback}</Go>
            {proofHref && <Go href="/room/house" locale={locale} className="pt-cta pt-cta--ghost">{m.live.room}</Go>}
          </div>
        </aside>
      </div>
    </section>
  );
}

/** The story: problem and solution (id="pitch") and the links. Each fact has one home on /about; the rest points here with an anchor. */
export function PitchStory({ locale }: { locale: Locale }) {
  const m = getPitchMessages(locale);
  return (
    <>
      <section className="pt-sec" id="pitch" aria-labelledby="pt-why-h">
        <p className="pt-kicker">{m.why.kicker}</p>
        <h2 id="pt-why-h">{m.why.heading}</h2>
        <div className="pt-why">
          {m.why.blocks.map((b, i) => (
            <div className="pt-why-block pt-glass" key={b.title}>
              <span className="pt-feature-no" aria-hidden="true">{no(i)}</span>
              <h3>{b.title}</h3>
              {b.body && <p>{b.body}</p>}
              {b.points.length > 0 && (
                <ul className="pt-points">
                  {b.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="pt-sec" id="facts" aria-label={m.submission.linksLabel}>
        <dl className="pt-facts">
          <div>
            <dt>{m.submission.linksLabel}</dt>
            <dd className="pt-facts-links">
              {m.submission.links.map((l) => (
                <Go key={l.label} href={l.href} locale={locale}>{l.label}</Go>
              ))}
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}
