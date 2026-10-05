/**
 * /[locale]/about: one page for everything that explains Hammerprice, in the pitch formatting (big type, alternating blocks,
 * glass panels, solid yellow buttons), with a sticky in-page nav. In page order: the hero, How it works (#how: six steps for the
 * buyer, the seller and the room host) with the image strip directly under it (#screens), the one consolidated function
 * description (#features), verified randomness with a live proof (#verify), the pitch (#pitch), the
 * FAQ with the wallet help and the glossary (#faq, #wallet, #glossary) and the founder (#team).
 *
 * The old routes (/how-it-works, /pitch, /faq) redirect to the matching section (next.config.js, src/lib/old-routes.json).
 * The route file (src/app/[locale]/about/page.tsx) reads the vault count and the live proof link and renders
 * `<AboutPage locale total proofHref>`.
 */
import Logo from '@/components/brand/Logo';
import type { Metadata } from 'next';
import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/config';
import { pageMetadata, organizationJsonLd } from '@/components/landing/seo';
import { CONTACT_EMAIL, GITHUB_ORG_URL, vaultFloorLabel } from '@/components/landing/site';
import JsonLd from '@/components/landing/JsonLd';
import { PitchHero, PitchShowcase, PitchFeatures, PitchVerify, PitchStory } from '@/components/pitch/PitchSections';
import Go from '@/components/pitch/Go';
import { getExplainMessages } from './content';
import HowSections from './HowSections';
import FaqSections from './FaqSections';
import OpenOnHash from './OpenOnHash';

const resolve = (l: string): Locale => (isLocale(l) ? l : defaultLocale);

/** The sections in page order, which is also the order of the sticky nav. */
export const ABOUT_SECTIONS = ['how', 'features', 'verify', 'pitch', 'faq', 'team'] as const;

export function aboutMetadata(locale: string): Metadata {
  const l = resolve(locale);
  const m = getExplainMessages(l).about;
  return pageMetadata({ locale: l, path: '/about', title: m.meta.title, description: m.meta.description });
}

export default function AboutPage({ locale, total, proofHref = null }: { locale: string; total?: string; proofHref?: string | null }) {
  const l = resolve(locale);
  const all = getExplainMessages(l);
  const m = all.about;

  return (
    <div className="pt ab" lang={l}>
      <JsonLd data={organizationJsonLd()} />
      <OpenOnHash />
      <div className="pt-wrap">
        <PitchHero locale={l} kicker={m.kicker} />
      </div>

      <nav className="ab-nav" aria-label={m.nav.label} data-testid="about-nav">
        <ul>
          {ABOUT_SECTIONS.map((id) => (
            <li key={id}>
              <a href={`#${id}`}>{m.nav[id]}</a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="pt-wrap">
        <HowSections locale={l} />
        <PitchShowcase locale={l} />
        <PitchFeatures locale={l} total={total ?? `${vaultFloorLabel(l)}+`} />
        <PitchVerify locale={l} proofHref={proofHref} />
        <PitchStory locale={l} />
        <FaqSections locale={l} />

        <section className="pt-sec" id="team" aria-labelledby="ab-team-heading">
          <p className="pt-kicker">{m.team.kicker}</p>
          <h2 id="ab-team-heading">{m.team.heading}</h2>
          <p className="pt-lede">{m.team.intro}</p>
          <div className="pt-glass pt-who">
            <Logo variant="symbol" className="pt-who-mark" />
            <h3>{m.who.heading}</h3>
            <dl>
              <div>
                <dt>{m.who.name}</dt>
                <dd>{m.who.role}</dd>
                {m.who.facts.map((f) => (
                  <dd key={f}>{f}</dd>
                ))}
              </div>
              <div>
                <dt>{m.who.contactLabel}</dt>
                <dd>
                  <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
                </dd>
              </div>
              <div>
                <dt>{m.who.githubLabel}</dt>
                <dd>
                  <a href={GITHUB_ORG_URL} target="_blank" rel="noopener noreferrer">
                    github.com/FutureWebservice
                  </a>
                </dd>
              </div>
            </dl>
            <p>{m.who.operator}</p>
            <p className="pt-who-note">{m.who.githubNote}</p>
          </div>
        </section>

        <section className="pt-sec pt-closing-sec" aria-labelledby="ab-close-heading">
          <h2 id="ab-close-heading">{all.closing.heading}</h2>
          <p className="pt-lede">{all.closing.body}</p>
          <div className="pt-bill-ctas">
            <Go href="/rooms" locale={l} className="pt-cta">{all.closing.cta}</Go>
            <Go href="/sell" locale={l} className="pt-cta pt-cta--ghost">{all.closing.sell}</Go>
            <Go href="/#waitlist" locale={l} className="pt-cta pt-cta--ghost">{all.closing.waitlist}</Go>
          </div>
        </section>

      </div>
    </div>
  );
}
