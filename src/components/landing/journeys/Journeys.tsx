/**
 * "What you can do on Hammerprice": the one place where the landing page presents the features, after the real cards and before the
 * waiting list. Seven user journeys (the packs one only while packs run) as alternating blocks, each with a heading, two to four short steps, a small decorative picture
 * (visuals.tsx) and a button that is a link to the real page. An "And more" block follows with the other eight features (timed
 * auctions, verifiable random lot order, packs, live video, AI listing draft and room assistant, public audit and verify pages,
 * German and English, wallet support), each with one or two sentences and a link.
 *
 * Server component over src/locales/{de,en}/landing.json (`journeys`), read directly. Where a link target belongs to a
 * registry feature (src/content/features.ts) the button or link shows only while that feature runs on this deployment (a switched-off
 * feature answers 404). Pages that always exist (/rooms, /sell, /account) are plain hrefs. No script, no motion, no layout shift.
 */
import Link from 'next/link';
import './journeys.css';
import en from '@/locales/en/landing.json';
import de from '@/locales/de/landing.json';
import type { Locale } from '@/lib/i18n';
import { FEATURES, featureStatus, linkOf, type FeatureId } from '@/content/features';
import { JOURNEY_VISUALS, PacksFlow } from './visuals';

type Env = Record<string, string | undefined>;
/** `reg`: the registry feature the page belongs to; the link shows only while it runs. `href`: a page that always exists (or the registry link). */
type Target = { href: string; reg?: FeatureId; external?: boolean };

export const JOURNEYS: ReadonlyArray<{ id: 'bid' | 'sell' | 'packs' | 'chat' | 'telegram' | 'agent' | 'profile'; cta: Target; cta2?: Target }> = [
  { id: 'bid', cta: { href: '/rooms' } },
  { id: 'sell', cta: { href: '/sell' } },
  { id: 'packs', cta: { href: '/packs', reg: 'packs' } },
  { id: 'chat', cta: { href: '/rooms' } },
  { id: 'telegram', cta: { href: '/account?telegram=open', reg: 'telegram' }, cta2: { href: 'https://t.me/hammerpricebot', reg: 'telegram', external: true } },
  { id: 'agent', cta: { href: '/ai', reg: 'ai' } },
  { id: 'profile', cta: { href: '/account' } },
];

/**
 * The "And more" block. `reg`: the link comes from the registry and shows only while the feature runs. `href`: a page or anchor that always
 * exists (the audit page needs a lot id, so verify points to the verified-randomness section on /about). `languages` links to this page in the other language.
 */
export const MORE: ReadonlyArray<{ id: 'timed' | 'random' | 'packs' | 'video' | 'draft' | 'verify' | 'languages' | 'wallets'; reg?: FeatureId; href?: string }> = [
  { id: 'timed', reg: 'timed' },
  { id: 'random', reg: 'random' },
  { id: 'packs', reg: 'packs' },
  { id: 'video', reg: 'video' },
  { id: 'draft', reg: 'ai' },
  { id: 'verify', href: '/about#verify' },
  { id: 'languages' },
  { id: 'wallets', href: '#wallet' },
];

/** The slim row under the packs block: one title and one short line each, with a link to the matching anchor of the explainer on /packs (the details live there, once). */
export const PACK_DETAILS = ['odds', 'build', 'delivery'] as const;

const MESSAGES = { en: en.journeys, de: de.journeys } as const;

function resolve(t: Target | undefined, env: Env): { href: string; external: boolean } | null {
  if (!t) return null;
  if (t.reg) {
    const entry = FEATURES.find((f) => f.id === t.reg)!;
    if (featureStatus(entry, env) === 'off') return null;
  }
  return { href: t.href, external: !!t.external };
}

function Cta({ locale, to, label, secondary }: { locale: Locale; to: { href: string; external: boolean }; label: string; secondary?: boolean }) {
  const cls = secondary ? 'hp-j-cta hp-j-cta--alt' : 'hp-j-cta';
  return to.external ? (
    <a className={cls} href={to.href} target="_blank" rel="noopener noreferrer">{label}</a>
  ) : (
    <Link className={cls} href={`/${locale}${to.href}`}>{label}</Link>
  );
}

/** Where an "And more" link goes: a site path (locale prefix added), an in-page anchor, or the other language's landing page. */
function moreLink(m: (typeof MORE)[number], locale: Locale, env: Env): { href: string; lang?: Locale } | null {
  // The packs card points at the full packs block above (no second description); it goes with the block when packs are off.
  if (m.id === 'packs') return resolve({ href: '#journey-packs', reg: 'packs' }, env) ? { href: '#journey-packs' } : null;
  if (m.id === 'languages') {
    const other: Locale = locale === 'de' ? 'en' : 'de';
    return { href: `/${other}`, lang: other };
  }
  if (m.reg) {
    const entry = FEATURES.find((f) => f.id === m.reg)!;
    const href = linkOf(entry, featureStatus(entry, env));
    return href ? { href: `/${locale}${href}` } : null;
  }
  return { href: m.href!.startsWith('#') ? m.href! : `/${locale}${m.href}` };
}

export default function Journeys({ locale, env = process.env }: { locale: Locale; env?: Env }) {
  const j = MESSAGES[locale] ?? MESSAGES.en;
  return (
    <section className="hp-sec hp-j" id="hp-journeys" aria-labelledby="hp-journeys-h">
      <h2 className="hp-h2" id="hp-journeys-h">{j.heading}</h2>
      <p className="hp-note">{j.intro}</p>
      {JOURNEYS.map(({ id, cta, cta2 }) => ({ id, cta, cta2, first: resolve(cta, env), second: resolve(cta2, env) }))
        // A journey whose page is switched off is not presented at all (the packs block); the others have an always-on page.
        .filter((x) => x.id !== 'packs' || x.first)
        .map(({ id, first, second }, i) => {
        const item = j.items[id] as (typeof j.items)[typeof id] & { cta2?: string; details?: Record<(typeof PACK_DETAILS)[number], { title: string; line: string }>; detailsLink?: string; flow?: Record<string, string> };
        const Visual = JOURNEY_VISUALS[id];
        return (
          <section key={id} className={`hp-jb${i % 2 ? ' hp-jb--flip' : ''}`} id={`journey-${id}`} aria-labelledby={`journey-${id}-h`} data-journey={id}>
            <div className="hp-jb-text">
              <h3 className="hp-jb-h" id={`journey-${id}-h`}>{item.title}</h3>
              <p className="hp-jb-lead">{item.lead}</p>
              <ol className="hp-jsteps">
                {item.steps.map((s) => <li key={s}>{s}</li>)}
              </ol>
              {(first || second) && (
                <p className="hp-jb-ctas">
                  {first && <Cta locale={locale} to={first} label={item.cta} />}
                  {second && item.cta2 && <Cta locale={locale} to={second} label={item.cta2} secondary />}
                </p>
              )}
            </div>
            <div className="hp-jb-vis" aria-hidden="true">
              <Visual m={item.mock as Record<string, string>} />
              <span className="hp-jb-ex">{j.example}</span>
            </div>
            {item.flow && <PacksFlow f={item.flow} />}
            {item.details && (
              <ul className="hp-jx hp-jd">
                {PACK_DETAILS.map((d) => (
                  <li key={d} className="hp-jd-card" data-detail={d}>
                    <h4 className="hp-jd-t">{item.details![d].title}</h4>
                    <p>{item.details![d].line}</p>
                    <Link className="hp-jd-link" href={`/${locale}/packs#${d}`}>{item.detailsLink}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <section className="hp-jmore" aria-labelledby="hp-jmore-h">
        <h3 className="hp-jb-h hp-jmore-h" id="hp-jmore-h">{j.moreHeading}</h3>
        <ul className="hp-jmore-list">
          {MORE.map((m) => {
            const item = j.more[m.id];
            const to = moreLink(m, locale, env);
            return (
              <li key={m.id} className="hp-jmore-item" data-more={m.id}>
                <h4 className="hp-jmore-t">{item.title}</h4>
                <p>{item.line}</p>
                {to && (to.href.startsWith('#') || to.lang ? (
                  <a className="hp-jmore-link" href={to.href} hrefLang={to.lang}>{item.link}</a>
                ) : (
                  <Link className="hp-jmore-link" href={to.href}>{item.link}</Link>
                ))}
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
}
