import { describe, it, expect, vi } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import fs from 'node:fs';
import path from 'node:path';
import LegalPage from '@/components/legal/LegalPage';
import LegalLinkRow from '@/components/legal/LegalLinkRow';
import NetworkModeNotice from '@/components/legal/NetworkModeNotice';
import Footer from '@/components/layout/Footer';
import { CONTENT_DIR, legalTitles, loadLegalDoc, splitFrontMatter } from '@/legal/content';
import { LEGAL, OPERATOR } from '@/legal/config';
import { LEGAL_KEYS, SLUGS, buildRedirects, keyForCanonicalSlug, legalPath, rewriteLegalLink, staticSlugs } from '@/legal/routes';
import { SITE_ROUTES, findRoute } from '@/lib/site-routes';
import { locales, type Locale } from '@/lib/i18n/config';
import deFooter from '@/locales/de/footer.json';
import enFooter from '@/locales/en/footer.json';
import deLegal from '@/locales/de/legal.json';
import enLegal from '@/locales/en/legal.json';
import redirects from '@/legal/redirects.json';

// next-intl's navigation needs the Next runtime. The real Link prefixes the locale; this stand-in does the same.
const nav = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('@/lib/i18n', async () => {
  const { createElement: h } = await import('react');
  return { Link: (p: { href: string; className?: string; children?: unknown }) => h('a', { href: `/${nav.locale}${p.href}`, className: p.className }, p.children as never) };
});

const EM_DASH = '\u2014';
const page = (locale: Locale, key: (typeof LEGAL_KEYS)[number]) => renderToStaticMarkup(createElement(LegalPage, { locale, docKey: key }));
const allFiles = () => locales.flatMap((l) => LEGAL_KEYS.map((k) => ({ l, k, file: path.join(CONTENT_DIR, l, `${k}.md`) })));

describe('every legal page renders in both languages with the real config', () => {
  for (const locale of locales) {
    for (const key of LEGAL_KEYS) {
      it(`${locale}/${key}`, () => {
        const html = page(locale, key);
        expect(html).toContain('<h1>');
        expect(html).not.toMatch(/\{\{|\}\}/); // no placeholder left
        expect(html).not.toContain('<!--');
        expect(html).not.toContain('&lt;!--');
        expect(html).not.toContain(EM_DASH);
        expect(html).not.toMatch(/\bundefined\b|\[object/);
      });
    }
  }

  it('the Impressum prints the operator data from the config', () => {
    for (const l of locales) {
      const html = page(l, 'impressum');
      for (const s of [OPERATOR.name, OPERATOR.owner, 'Albert-Einstein-Straße 47', '02977 Hoyerswerda', OPERATOR.email, l === 'de' ? '§ 19 UStG' : 'Section 19 UStG']) expect(html, `${l} ${s}`).toContain(s);
      expect(html).toContain('c/o Autorenglück #78416');
      expect(html).not.toContain('bonkstream');
    }
  });

  it('the privacy text names the real regions and every third party the browser contacts', () => {
    for (const l of locales) {
      const html = page(l, 'datenschutz');
      expect(html).toContain(LEGAL.values[l].HOSTING_REGION);
      expect(html).toContain(LEGAL.values[l].DB_REGION);
      expect(html).toContain('CloudFront');
      expect(html).toContain('Helius');
      expect(html).toContain('Sächsische Datenschutz- und Transparenzbeauftragte');
      expect(html).not.toMatch(/Frankfurt|eu-central/);
    }
  });

  it('the cookies page lists exactly the storage table and no banner claim it cannot keep', () => {
    for (const l of locales) {
      const html = page(l, 'cookies');
      for (const k of ['walletName', 'hp_session', 'hp:paddle', 'hp.sell.recent', 'hp.video', 'hp.pack', 'hp.tour.v1']) expect(html, k).toContain(k);
      expect(html).not.toContain('NEXT_LOCALE');
      expect(html).not.toContain('theme');
    }
  });

  it('the terms describe the co-sign rail: both sign, the authority sponsors fees, automatic close, no delegate', () => {
    const en = page('en', 'terms');
    expect(en).toContain('Neither key can move the card or the money alone');
    expect(en).toContain('settlement authority');
    expect(en).toContain('has no authority over any asset');
    expect(en).toContain('closes by itself');
    expect(en).toContain('Place binding bid, payment due if you win');
    expect(en).toMatch(/withdraw a lot only before the first valid bid/);
    const de = page('de', 'terms');
    expect(de).toContain('Kein Schlüssel kann allein die Karte oder das Geld bewegen');
    expect(de).toContain('Verbindlich bieten, zahlungspflichtig');
    for (const html of [en, de]) expect(html).not.toMatch(/delegat|escrow|Marktplatz-Programm|marketplace program|Buy now|Sofortkauf/i);
  });

  it('no text mentions the old product or unbuilt features', () => {
    for (const { l, k, file } of allFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      expect(src, `${l}/${k}`).not.toMatch(/escrow|delegat|juror|won the ideathon|gewonnen|\{\{JUROR/i);
      // The video server is named only where the visitor needs it: the privacy text (and the storage and recipient tables it prints).
      if (k !== 'datenschutz') expect(src, `${l}/${k}`).not.toMatch(/bonkstream/i);
    }
  });

  it('the privacy text names every optional processing the merged packages added (DE and EN)', () => {
    for (const l of locales) {
      const html = page(l, 'datenschutz');
      for (const s of ['Google', 'Gemini', 'Vertex', 'Telegram', 'stream.bonkstream.com', 'ECVRF', '18']) expect(html, `${l} ${s}`).toContain(s);
      expect(html).toMatch(/iad1/);
      expect(html).toMatch(/us-east-1/);
      expect(html).toMatch(/Data Privacy Framework/);
      expect(html).toMatch(/Standard ?(Contractual Clauses|vertragsklauseln)/);
    }
  });

  it('the terms have the chapters for timed auctions, chat, AI, video and packs, and packs are not forbidden by chapter 12', () => {
    const en = page('en', 'terms');
    for (const h of ['18. Timed auctions', '19. Room chat', '20. AI functions', '21. Live video', '22. Packs']) expect(en).toContain(h);
    expect(en).toMatch(/at least 18 or older|18 or older/);
    expect(en).toContain('Hammerprice provides the technology');
    expect(en).toMatch(/outside the pack function of the Platform/);
    const de = page('de', 'terms');
    for (const h of ['18. Timed-Auktionen', '19. Raum-Chat', '20. KI-Funktionen', '21. Live-Video', '22. Packs']) expect(de).toContain(h);
    expect(de).toContain('mindestens 18 Jahre alt');
    expect(de).toMatch(/außerhalb der Pack-Funktion/);
  });

  it('the risk notice and the fees page cover packs and credits, and no legal text claims a public repository or EU hosting', () => {
    expect(page('en', 'risk')).toContain('Packs: the card is drawn at random');
    expect(page('de', 'risk')).toContain('Packs: Die Karte wird zufällig gezogen');
    expect(page('en', 'fees')).toContain('AI credits');
    expect(page('de', 'fees')).toContain('KI-Guthaben');
    for (const { l, k, file } of allFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      expect(src, `${l}/${k}`).not.toMatch(/repositor(y|ium) (is|ist) (public|öffentlich)|public repo|öffentliches Repo/i);
      expect(src, `${l}/${k}`).not.toMatch(/hosted in the EU|EU hosting|in der EU gehostet|EU-Hosting|Frankfurt|eu-central/i);
    }
  });
});

describe('the texts match the product of October 2026 (live beta, Telegram, profile, waiting list, AI agent, admin)', () => {
  it('the terms cover profile, Telegram, waiting list, the beta status, the AI agent and the timed demo window', () => {
    const en = page('en', 'terms');
    for (const s of ['4.3 Profile', '4.4 Telegram', '@hammerpricebot', 'never bids for you', '4.5 Waiting list', '17.4', 'not promised', '20.5 The AI agent', 'The AI agent never uses a credit', 'in demonstration mode it is 6 hours']) expect(en, s).toContain(s);
    const de = page('de', 'terms');
    for (const s of ['4.3 Profil', '4.4 Telegram', '@hammerpricebot', 'bietet nie für Sie', '4.5 Warteliste', '17.4', 'nicht zugesagt', '20.5 Der KI-Agent', 'Der KI-Agent verbraucht nie ein Guthaben', 'beträgt sie 6 Stunden']) expect(de, s).toContain(s);
  });

  it('the privacy text covers the AI agent, the waiting list purpose as the form words it, the profile page and the admin area', () => {
    const en = page('en', 'datenschutz');
    for (const s of ['AI agent', 'no conversation with the agent', 'reachable on the main network', 'on your profile page', '3.15 The operator', 'There is no automatic deletion of the log lines']) expect(en, s).toContain(s);
    expect(en).not.toContain('account page');
    const de = page('de', 'datenschutz');
    for (const s of ['KI-Agent', 'kein Gespräch mit dem Agenten', 'im Hauptnetz', 'auf Ihrer Profilseite', '3.15 Verwaltungsbereich des Betreibers', 'Eine automatische Löschung der Protokollzeilen gibt es derzeit nicht']) expect(de, s).toContain(s);
    expect(de).not.toContain('Konto-Seite');
  });

  it('the risk notice agrees with the fees page on who pays network fees, and names the beta, the agent and Telegram', () => {
    for (const l of locales) {
      const risk = page(l, 'risk');
      expect(risk).not.toMatch(/may need a little SOL|unter Umständen etwas SOL/);
      expect(risk).toMatch(l === 'de' ? /Live-Beta/ : /live beta/);
      expect(risk).toMatch(l === 'de' ? /KI-Agent/ : /AI agent/);
      expect(risk).toMatch(l === 'de' ? /Telegram-Nachrichten können verspätet/ : /Telegram messages can arrive late/);
    }
  });

  it('the demonstration notice says live beta and that a mainnet launch is planned, not promised', () => {
    expect(LEGAL.values.en.NETWORK_MODE_NOTICE).toMatch(/live beta.*planned after the hackathon but is not promised/);
    expect(LEGAL.values.de.NETWORK_MODE_NOTICE).toMatch(/Live-Beta.*nach dem Hackathon geplant, aber nicht zugesagt/);
  });
});

describe('house style', () => {
  it('has no em dash in any legal content, footer or legal locale file', () => {
    for (const { l, k, file } of allFiles()) expect(fs.readFileSync(file, 'utf8'), `${l}/${k}`).not.toContain(EM_DASH);
    for (const obj of [deFooter, enFooter, deLegal, enLegal]) expect(JSON.stringify(obj)).not.toContain(EM_DASH);
    for (const src of ['src/legal/config.ts', 'src/legal/tables.ts']) expect(fs.readFileSync(src, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toContain(EM_DASH);
  });

  it('every text has a title and a description and starts with an h1', () => {
    for (const { l, k, file } of allFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      const { meta, body } = splitFrontMatter(src);
      expect(meta.title, `${l}/${k} title`).toBeTruthy();
      expect(meta.description?.length, `${l}/${k} description`).toBeGreaterThan(40);
      expect(meta.description.length).toBeLessThan(200);
      expect(body.trimStart().startsWith('# '), `${l}/${k} h1`).toBe(true);
    }
  });
});

describe('links and routes', () => {
  it('every internal link in every text resolves to an existing page', () => {
    const builtRoutes = new Set(SITE_ROUTES.map((r) => r.path));
    let checked = 0;
    for (const { l, k, file } of allFiles()) {
      const { body } = splitFrontMatter(fs.readFileSync(file, 'utf8'));
      for (const m of body.matchAll(/\]\((\/[^)\s]*)\)/g)) {
        const href = m[1];
        const rewritten = rewriteLegalLink(l, href);
        if (rewritten) {
          // canonical path of an existing page
          const slug = rewritten.split('/legal/')[1] ?? '';
          expect(rewritten.startsWith(`/${l}/legal`), `${l}/${k} ${href}`).toBe(true);
          if (slug) expect(keyForCanonicalSlug(l, slug), `${l}/${k} ${href}`).not.toBeNull();
        } else {
          expect(builtRoutes.has(href), `${l}/${k} links to ${href}, which is no page`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('German links to the terms go to /de/legal/agb, English ones to /en/legal/terms', () => {
    expect(rewriteLegalLink('de', '/legal/terms')).toBe('/de/legal/agb');
    expect(rewriteLegalLink('de', '/legal/agb')).toBe('/de/legal/agb');
    expect(rewriteLegalLink('en', '/legal/agb')).toBe('/en/legal/terms');
    expect(rewriteLegalLink('en', '/legal')).toBe('/en/legal');
    expect(rewriteLegalLink('en', '/legal/nothing')).toBeNull();
  });

  it('every slug in SPEC 2.2 has a page in both languages', () => {
    expect(SLUGS.terms).toEqual({ de: 'agb', en: 'terms' });
    expect(staticSlugs()).toHaveLength(8 * 2);
    for (const l of locales) for (const k of LEGAL_KEYS) expect(fs.existsSync(path.join(CONTENT_DIR, l, `${k}.md`)), `${l}/${k}`).toBe(true);
    expect(legalPath('de', 'terms')).toBe('/de/legal/agb');
    expect(legalPath('en', 'index')).toBe('/en/legal');
  });

  it('site-routes.ts lists the legal pages (the flags are the integrator\'s to flip)', () => {
    const paths = SITE_ROUTES.map((r) => r.path);
    expect(paths).toContain('/legal');
    for (const k of LEGAL_KEYS.filter((x) => x !== 'index')) for (const l of locales) expect(findRoute(legalPath(l, k)), `${l}/${k}`).toBeDefined();
    const agb = SITE_ROUTES.find((r) => r.path === '/legal/agb');
    const terms = SITE_ROUTES.find((r) => r.path === '/legal/terms');
    expect(agb?.locales).toEqual(['de']);
    expect(terms?.locales).toEqual(['en']);
  });

  it('redirects.json (read by next.config.js) matches the route table and only points at real pages', () => {
    expect(redirects).toEqual(buildRedirects());
    const real = new Set<string>([...LEGAL_KEYS].map((k) => legalPath('en', k)).concat(LEGAL_KEYS.map((k) => legalPath('de', k))));
    for (const r of redirects) {
      expect(real.has(r.destination), `${r.source} -> ${r.destination}`).toBe(true);
      expect(real.has(r.source), `${r.source} is itself a page`).toBe(false);
    }
    const sources = redirects.map((r) => r.source);
    expect(new Set(sources).size).toBe(sources.length);
    for (const s of ['/de/impressum', '/de/datenschutz', '/de/agb', '/de/legal/terms', '/en/legal/agb', '/legal/imprint', '/legal/privacy', '/legal/widerruf', '/legal/withdrawal', '/legal/notice']) expect(sources).toContain(s);
  });
});

describe('metadata', () => {
  it('has a canonical path and hreflang alternates for every page', async () => {
    const { legalMetadata } = await import('@/legal/metadata');
    const m = legalMetadata('de', 'terms');
    expect(m.alternates?.canonical).toBe('/de/legal/agb');
    expect(m.alternates?.languages).toMatchObject({ de: '/de/legal/agb', en: '/en/legal/terms', 'x-default': '/en/legal/terms' });
    expect(String(m.title)).toContain('| Hammerprice');
    expect(legalMetadata('en', 'index').alternates?.canonical).toBe('/en/legal');
    expect(legalTitles('de')).toHaveLength(LEGAL_KEYS.length);
    expect(loadLegalDoc('en', 'fees').title).toBe('Fees');
  });
});

describe('footer, notice and link row', () => {
  const wrap = (locale: Locale, el: ReturnType<typeof createElement>) => {
    nav.locale = locale;
    const messages = { footer: locale === 'de' ? deFooter : enFooter, legal: locale === 'de' ? deLegal : enLegal };
    return renderToStaticMarkup(createElement(NextIntlClientProvider as ComponentType<Record<string, unknown>>, { locale, messages, timeZone: 'Europe/Berlin' }, el));
  };

  it('the footer links to every legal page, the contact mailbox and no prize sentence', () => {
    for (const l of locales) {
      const html = wrap(l, createElement(Footer));
      for (const k of ['impressum', 'datenschutz', 'terms', 'cookies', 'consumer', 'risk', 'fees', 'dsa-contact', 'index'] as const) {
        expect(html, `${l} ${k}`).toContain(`href="${legalPath(l, k)}"`);
      }
      expect(html).toContain(`mailto:${OPERATOR.email}`);
      expect(html).toContain(OPERATOR.name);
    }
    // The prize sentence and the submission count are not in the footer any more (the owner's wording stays on the landing page, the pitch and llms.txt).
    expect(wrap('en', createElement(Footer))).not.toMatch(/prize winner|Ideathon|\(38 submissions\)/);
    expect(wrap('de', createElement(Footer))).not.toMatch(/Preisträger|Ideathon|\(38 Einreichungen\)/);
  });

  it('the footer makes no claim that is not true: no rank, no win, no juror, no support claim', () => {
    for (const obj of [deFooter, enFooter]) {
      const s = JSON.stringify(obj);
      expect(s).not.toMatch(/\b(won|winner of|1st|2nd|3rd|6th|7th|top ?10|gewonnen|Platz|juror|Jury)\b/i);
      expect(s).not.toMatch(/supported by|unterstützt von/i);
    }
  });

  it('the footer carries the single demo line on devnet (not the long legal notice, which stays on the legal pages), and the link row has the pages a bidder needs', () => {
    for (const l of ['en', 'de'] as const) {
      const f = wrap(l, createElement(Footer));
      expect(f).toContain('data-testid="footer-demo"');
      expect(f).not.toContain(l === 'en' ? 'Demonstration mode.' : 'Demonstrationsbetrieb.');
    }
    const row = wrap('en', createElement(LegalLinkRow));
    for (const k of ['impressum', 'datenschutz', 'terms', 'fees', 'risk'] as const) expect(row).toContain(`href="${legalPath('en', k)}"`);
    expect(renderToStaticMarkup(createElement(NetworkModeNotice, { locale: 'de', mode: 'devnet' }))).toContain('keinen Wert');
    expect(renderToStaticMarkup(createElement(NetworkModeNotice, { locale: 'de', mode: 'mainnet' }))).toBe('');
  });
});

describe('cross-references to the terms', () => {
  // Chapter number the other legal pages may point to, with the title it must have. A renumbering of the terms fails here.
  const TITLES: Record<string, { en: RegExp; de: RegExp }> = {
    '2': { en: /^Our role/, de: /^Unsere Rolle/ },
    '3': { en: /^Requirements for use/, de: /^Voraussetzungen der Nutzung/ },
    '4': { en: /^Free use and user agreement/, de: /^Kostenlose Nutzung/ },
    '6': { en: /^Hammer and conclusion/, de: /^Zuschlag und Vertragsschluss/ },
    '7': { en: /^Settlement/, de: /^Abwicklung/ },
    '8': { en: /^Non-performance/, de: /^Nichterfüllung/ },
    '9': { en: /^Fees/, de: /^Gebühren/ },
    '13': { en: /^Content rules/, de: /^Regeln für Inhalte/ },
    '22': { en: /^Packs/, de: /^Packs/ },
    '25': { en: /^Changes to these terms/, de: /^Änderung dieser/ },
    '27': { en: /^Consumer dispute resolution/, de: /^Verbraucherstreit/ },
  };
  const REF = /(?:(?:Terms|AGB|Nutzungsbedingungen)[^.\n]{0,50}?(?:sections?|Ziffern?) ([\d.]+(?: (?:and|und) [\d.]+)*))|(?:(?:read section|Ziffer) (\d+)(?: of the \[Terms\]|[^\n]{0,40}\[(?:AGB|Nutzungsbedingungen)\]))/g;

  it('every chapter number the other pages cite exists and has the intended title', () => {
    for (const l of locales) {
      const heads = new Map<string, string>();
      for (const m of fs.readFileSync(path.join(CONTENT_DIR, l, 'terms.md'), 'utf8').matchAll(/^## (\d+)\. (.*)$/gm)) heads.set(m[1], m[2]);
      for (const k of LEGAL_KEYS) {
        if (k === 'terms') continue;
        const src = fs.readFileSync(path.join(CONTENT_DIR, l, `${k}.md`), 'utf8');
        for (const m of src.matchAll(REF)) {
          const nums = (m[1] ?? m[2]).split(/ (?:and|und) /).map((n) => n.split('.')[0]);
          for (const n of nums) {
            expect(heads.has(n), `${l}/${k} cites chapter ${n}`).toBe(true);
            expect(TITLES[n], `${l}/${k} cites chapter ${n}: add it to TITLES`).toBeDefined();
            expect(heads.get(n), `${l}/${k} chapter ${n}`).toMatch(TITLES[n][l as 'en' | 'de']);
          }
        }
      }
    }
  });
});
