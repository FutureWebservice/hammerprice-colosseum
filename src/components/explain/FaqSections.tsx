/**
 * The "FAQ" section of /about (id="faq"; it was the page /faq, which redirects here): only the questions the other sections do not
 * already answer (paying and selling, packs, safety and fairness), with FAQPage JSON-LD, then the wallet help (id="wallet") and the
 * glossary (id="glossary") that the Help menu links to, in the wording the glossary uses on mainnet. Plain JSON copy (explain.json
 * `faqPage`). The assistant's own, fuller question list is `explain.json` `assistant` and is not shown here.
 */
import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/config';
import JsonLd from '@/components/landing/JsonLd';
import { getExplainMessages } from './content';
import WalletHelp from './WalletHelp';
import GlossaryList from '@/components/glossary/GlossaryList';
import '@/components/pitch/pitch.css';

export default function FaqSections({ locale }: { locale: string }) {
  const l: Locale = isLocale(locale) ? locale : defaultLocale;
  const all = getExplainMessages(l);
  const m = all.faqPage;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: l,
    mainEntity: m.groups.flatMap((g) =>
      g.items.map((i) => ({ '@type': 'Question', name: i.q, acceptedAnswer: { '@type': 'Answer', text: i.a } })),
    ),
  };

  return (
    <section className="pt-sec" id="faq" aria-labelledby="pt-faq-h">
      <JsonLd data={jsonLd} />
      <p className="pt-kicker">FAQ</p>
      <h2 id="pt-faq-h">{m.title}</h2>
      <p className="pt-lede">{m.intro}</p>

      <div className="pt-glass pt-faq-box">
        {m.groups.map((g) => (
          <section className="pt-faq-group" key={g.id} id={g.id} aria-labelledby={`pt-faq-${g.id}`}>
            <h3 id={`pt-faq-${g.id}`}>{g.heading}</h3>
            <dl className="pt-faq">
              {g.items.map((i) => (
                <div className="pt-faq-item" key={i.q}>
                  <dt>{i.q}</dt>
                  <dd>{i.a}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>

      <div className="pt-sub pt-glass">
        <WalletHelp locale={l} as="h3" />
      </div>

      <div className="pt-sub pt-glass">
        <GlossaryList as="h3" cluster="mainnet-beta" />
      </div>
    </section>
  );
}
