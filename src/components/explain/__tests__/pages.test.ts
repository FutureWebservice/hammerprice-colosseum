import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enTour from '@/locales/en/tour.json';
import deTour from '@/locales/de/tour.json';
import enGl from '@/locales/en/glossary.json';
import deGl from '@/locales/de/glossary.json';
import fs from 'node:fs';
import path from 'node:path';
import { IDEATHON_LINE, SITE_URL, CONTACT_EMAIL } from '@/components/landing/site';
import { getPitchMessages } from '@/components/pitch/content';
import { allFaq } from '@/server/ai/faq';
import { getExplainMessages, FAQ_KEYS, PANEL_KEYS } from '../content';
import { PANEL_ICONS } from '../icons';
import { visibleTermIds } from '@/components/glossary/terms';

// The page links through the locale-aware Link (next-intl's navigation needs a Next runtime); a stand-in that writes the same locale-prefixed href.
vi.mock('@/lib/i18n', () => ({
  locales: ['en', 'de'],
  defaultLocale: 'en',
  Link: ({ href, locale, children, className, hrefLang }: { href: string; locale?: string; children: React.ReactNode; className?: string; hrefLang?: string }) =>
    React.createElement('a', { href: `/${locale ?? 'en'}${href === '/' ? '' : href}`, className, hrefLang }, children),
}));

// vitest compiles JSX with the classic runtime (tsconfig says `preserve`), which needs React in scope.
(globalThis as unknown as { React: typeof React }).React = React;
const { default: AboutPage, aboutMetadata, ABOUT_SECTIONS } = await import('../AboutPage');
const { default: FaqSections } = await import('../FaqSections');
const { default: HowSections } = await import('../HowSections');
const { default: WalletHelp } = await import('../WalletHelp');

const LOCALES = ['en', 'de'] as const;
const PROOF = '/verify/random/0b6f6a52-3f0e-4a54-9d7e-1c2d3e4f5a6b';
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
// The FAQ section holds the glossary, a client island that reads its words from the provider the layout gives every page.
const MSG = { en: { tour: enTour, glossary: enGl }, de: { tour: deTour, glossary: deGl } };
const withIntl = (el: React.ReactElement, l: 'en' | 'de') => renderToStaticMarkup(React.createElement(NextIntlClientProvider as React.ComponentType<Record<string, unknown>>, { locale: l, messages: MSG[l], timeZone: 'Europe/Berlin' }, el));
/** What React writes for an apostrophe in text. */
const esc = (t: string) => t.replace(/'/g, '&#x27;');
const text = (h: string) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const ldBlocks = (h: string) => [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

/** What the owner's brief removed from this page: the status table, test-network wording, "not tested / never live / left out" caveats, "solo founder". */
const FORBIDDEN =
  /devnet|testnet|test network|testnetz|test[- ]usdc|replica|replikat|no real money|kein echtes geld|status table|statustabelle|not (yet )?(tested|verified)|never (been )?live|deliberately cut|bewusst gestrichen|nicht (live )?getestet|noch nicht (geprüft|verifiziert)|solo founder|alleingründer|(not|never|nothing|nichts|nie)\b[^.]{0,40}mainnet/i;

describe.each(LOCALES)('about page (%s)', (l) => {
  const h = withIntl(React.createElement(AboutPage, { locale: l, total: '151,000+', proofHref: PROOF }), l);
  const m = getExplainMessages(l).about;
  const all = getExplainMessages(l);
  const pitch = getPitchMessages(l);
  const ids = [...h.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
  const at = (id: string) => ids.indexOf(id);

  it('has one h1, the headline, over "About us" / "Über uns"; the founder with the facts, the contact and the GitHub organisation', () => {
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(m.title).toBe(l === 'de' ? 'Über uns' : 'About us');
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(h)![1].replace(/<[^>]+>/g, '');
    expect(h1).toBe(pitch.headline.before + pitch.headline.em + pitch.headline.after);
    expect(text(h)).toContain(m.kicker);
    expect(h).toContain('Farshad Shadjari');
    expect(h).toContain(`>${m.who.role}<`);
    expect(m.who.role).toBe(l === 'de' ? 'Gründer' : 'Founder');
    for (const f of m.who.facts) expect(h).toContain(esc(f));
    // The facts of claim 58: a master's student of Business Computer Science at FernUniversität in Hagen, Future Webservice, Germany. No team size.
    expect(text(h)).toContain('FernUniversität in Hagen');
    expect(text(h)).toContain('Future Webservice');
    expect(text(h)).toMatch(l === 'de' ? /Wirtschaftsinformatik/ : /Business Computer Science/);
    expect(h).toContain(`mailto:${CONTACT_EMAIL}`);
    expect(h).toContain('https://github.com/FutureWebservice');
  });

  it('has a sticky in-page nav: How it works, Functions, Randomness, Pitch, FAQ, Founder, each pointing at one section in page order', () => {
    const nav = /<nav class="ab-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(h)![1];
    const links = [...nav.matchAll(/<a href="#([a-z]+)">([^<]+)<\/a>/g)].map((x) => [x[1], x[2].replace('&#x27;', "'")]);
    expect(ABOUT_SECTIONS).toEqual(['how', 'features', 'verify', 'pitch', 'faq', 'team']);
    expect(links).toEqual(ABOUT_SECTIONS.map((id) => [id, m.nav[id]]));
    for (const [id] of links) expect(ids.filter((x) => x === id), id).toHaveLength(1);
    expect(h).toContain(`aria-label="${m.nav.label}"`);
    const order = ['how', 'screens', 'features', 'verify', 'pitch', 'facts', 'faq', 'wallet', 'glossary', 'team'].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps every anchor used elsewhere (#how, #pitch, #faq, #wallet, #glossary, #team) and adds #verify and #features, each exactly once; the status table is gone', () => {
    for (const id of ['how', 'pitch', 'faq', 'wallet', 'glossary', 'team', 'verify', 'features', 'screens', ...all.faqPage.groups.map((g) => g.id)]) {
      expect(ids.filter((x) => x === id), id).toHaveLength(1);
    }
    expect(ids.filter((x, i) => ids.indexOf(x) !== i)).toEqual([]);
    expect(ids).not.toContain('status');
    expect(h).not.toMatch(/data-claim-id|<table/);
  });

  it('How it works: six steps for the three roles, and the image strip directly under it', () => {
    const how = h.slice(h.indexOf('id="how"'), h.indexOf('id="screens"'));
    expect(pitch.how.steps).toHaveLength(6);
    for (const s of pitch.how.steps) expect(how).toContain(esc(s.title));
    expect(how.match(/<li class="pt-how-step/g)).toHaveLength(6);
    for (const role of [pitch.how.roles.buyer, pitch.how.roles.seller, pitch.how.roles.host]) expect(how).toContain(`>${role}<`);
    // Written for a running service, process only: the payment itself is described once, under Functions, and the step links there.
    expect(text(how)).toContain('USDC');
    expect(how).toContain('href="#features"');
    // The image strip: all ten pictures, in the order of the data, between How it works and the functions.
    const strip = h.slice(h.indexOf('id="screens"'), h.indexOf('id="features"'));
    expect(strip.match(/<li class="pt-shot /g)).toHaveLength(10);
    for (const s of pitch.showcase.items) expect(strip).toContain(`src="${s.src}"`);
    expect(strip).not.toContain('status.jpg');
  });

  it('Functions: every function of the platform in one place, with the vault count', () => {
    const feats = h.slice(h.indexOf('id="features"'), h.indexOf('id="verify"'));
    expect(pitch.features.items).toHaveLength(14);
    for (const f of pitch.features.items) expect(feats).toContain(esc(f.title));
    expect(feats).toContain('151,000+');
    for (const re of l === 'de'
      ? [/Räume/, /Transaktion/, /Zeitlich/, /Verkaufsassistent/, /Vormoderiert/, /KI-Agent/, /Telegram/, /\/watch/, /Packs/, /Profil/, /ECVRF/, /Prüfseiten/, /Deutsch und Englisch/, /Wallet-Unterstützung/]
      : [/Rooms/, /transaction/, /Timed/, /wizard/, /moderated/, /AI agent/, /Telegram/, /\/watch/, /Packs/, /Profile/, /ECVRF/, /audit/, /German and English/, /Wallet support/]) {
      expect(text(feats)).toMatch(re);
    }
  });

  it('Verified randomness: its own section with what it is, how to check it and a link to the live proof of the house room', () => {
    const v = h.slice(h.indexOf('id="verify"'), h.indexOf('id="pitch"'));
    expect(v).toContain(esc(pitch.verify.what));
    expect(pitch.verify.what.split(/(?<=[.])\s+/)).toHaveLength(3); // three sentences
    for (const s of pitch.verify.steps) expect(v).toContain(esc(s));
    expect(v).toContain(`href="/${l}${PROOF}"`);
    expect(v).toContain(`href="/${l}/room/house"`);
    expect(v).toContain(esc(pitch.verify.live.cta));
  });

  it('Verified randomness: without a proof to show, the button opens the house room instead', () => {
    const none = withIntl(React.createElement(AboutPage, { locale: l, total: '1', proofHref: null }), l);
    const v = none.slice(none.indexOf('id="verify"'), none.indexOf('id="pitch"'));
    expect(v).not.toContain('/verify/random/');
    expect(v).toContain(`href="/${l}/room/house"`);
    expect(v).toContain(esc(pitch.verify.live.ctaFallback));
  });

  it('merges the rest: the pitch (problem, solution, why it works), the fact links, the FAQ and the founder are all on it, each fact once', () => {
    for (const b of pitch.why.blocks) expect(h).toContain(esc(b.title));
    expect(text(h)).toContain('ZAG');
    for (const g of all.faqPage.groups) { expect(h).toContain(esc(g.heading)); for (const q of g.items) expect(h).toContain(esc(q.q)); }
    for (const sentence of [pitch.tagline, pitch.verify.what, all.closing.body]) expect(h.split(esc(sentence)), sentence).toHaveLength(2);
  });

  it('says nothing about the network, the status table, what is not tested or left out, and nothing about a solo founder', () => {
    expect(text(h)).not.toMatch(FORBIDDEN);
    const copy = JSON.stringify([pitch, m, all.faqPage, all.walletHelp, all.closing]);
    expect(copy).not.toMatch(FORBIDDEN);
    expect(copy).not.toContain('\u2014');
  });

  it('links to no page that moved: every link into the old routes is gone', () => {
    expect(h).not.toMatch(/href="[^"]*\/(?:how-it-works|pitch|faq)(?:[#"/])/);
  });

  it('carries the ideathon wording exactly (in the hero), with no rank and no claim of winning', () => {
    expect(h).toContain(esc(IDEATHON_LINE[l]));
    expect(h.split(esc(IDEATHON_LINE[l]))).toHaveLength(2); // once, not once per merged page
    expect(text(h)).not.toMatch(/\b(6th|7th|won the ideathon)\b/i);
  });

  it('emits Organization and FAQPage structured data and renders no placeholder text', () => {
    const blocks = ldBlocks(h);
    expect(blocks[0]).toMatchObject({ '@type': 'Organization', name: 'Hammerprice' });
    const faq = blocks.find((b) => b['@type'] === 'FAQPage');
    expect(faq.mainEntity).toHaveLength(all.faqPage.groups.flatMap((g) => g.items).length);
    expect(h).not.toMatch(/undefined|\[object|\{\{|TODO/);
    expect(h).toContain(`lang="${l}"`);
  });

  it('has localized metadata with canonical and hreflang', () => {
    const md = aboutMetadata(l);
    expect(md.title).toBe(m.meta.title);
    expect(md.alternates?.canonical).toBe(`${SITE_URL}/${l}/about`);
    expect(md.alternates?.languages).toHaveProperty('en');
    expect(md.alternates?.languages).toHaveProperty('de');
  });
});

describe('both languages carry the same page', () => {
  const en = getPitchMessages('en');
  const de = getPitchMessages('de');
  const exEn = getExplainMessages('en');
  const exDe = getExplainMessages('de');

  it('the same steps, roles, functions, links, pictures and FAQ groups, in the same order', () => {
    expect(de.how.steps.map((s) => [s.roles, s.link?.href ?? null])).toEqual(en.how.steps.map((s) => [s.roles, s.link?.href ?? null]));
    expect(de.features.items.map((f) => f.link?.href ?? null)).toEqual(en.features.items.map((f) => f.link?.href ?? null));
    expect(de.showcase.items.map((s) => s.id)).toEqual(en.showcase.items.map((s) => s.id));
    expect(de.why.blocks.map((b) => b.points.length)).toEqual(en.why.blocks.map((b) => b.points.length));
    expect(exDe.faqPage.groups.map((g) => [g.id, g.items.length])).toEqual(exEn.faqPage.groups.map((g) => [g.id, g.items.length]));
    expect(exDe.assistant.quick.items).toHaveLength(exEn.assistant.quick.items.length);
    expect(exDe.assistant.groups.map((g) => [g.id, g.items.length])).toEqual(exEn.assistant.groups.map((g) => [g.id, g.items.length]));
  });

  it('German speaks to the reader in the Sie form', () => {
    const copy = JSON.stringify([de, exDe.about, exDe.assistant, exDe.faqPage, exDe.walletHelp, exDe.closing]);
    expect(copy).not.toMatch(/\b(du|dein|deine|deinen|deiner|dir)\b/i);
    expect(copy).toMatch(/\bSie\b|\bIhre\b/);
  });

  it('every FAQ entry the assistant answers from is valid on mainnet too (no test-network wording)', () => {
    const entries = allFaq().filter((e) => !e.extra);
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.filter((e) => e.testOnly).map((e) => e.key)).toEqual([]);
  });
});

describe.each(LOCALES)('faq section (%s)', (l) => {
  const h = withIntl(React.createElement(FaqSections, { locale: l }), l);
  const m = getExplainMessages(l).faqPage;
  const questions = m.groups.flatMap((g) => g.items);

  it('renders only the questions the other sections do not answer, each with its answer, then the wallet help and the glossary', () => {
    expect(h).toContain('id="faq"');
    for (const g of m.groups) expect(h).toContain(g.heading);
    // The glossary sits at the end of the section (id="glossary", the target of the Help menu): its words are counted apart from the questions.
    const glossary = h.slice(h.indexOf('id="glossary"'));
    expect(h).toContain('data-testid="glossary-list"');
    expect(glossary.match(/<dt>/g)).toHaveLength(visibleTermIds('mainnet-beta').length);
    expect(h.slice(0, h.indexOf('id="glossary"')).match(/<dt>/g)).toHaveLength(questions.length);
    expect(questions.length).toBeLessThanOrEqual(10);
    for (const q of questions) {
      expect(h).toContain(esc(q.q));
      expect(q.a.length).toBeGreaterThan(20);
    }
    expect(h).not.toContain('<details');
    expect(h.match(/<h1/g)).toBeNull();
  });

  it('keeps what is not said anywhere else: the signing window, the lapse, the fee mechanics, the seller requirements, packs, custody, the audit page and the legal reading', () => {
    const t = text(h).toLowerCase();
    for (const word of ['15', 'USDC', 'ZAG', 'GlüStV', l === 'de' ? 'Pack' : 'pack', l === 'de' ? 'Prüfseite' : 'audit page', l === 'de' ? 'Verwarnung' : 'strike']) expect(t, word).toContain(word.toLowerCase());
    expect(t).not.toMatch(FORBIDDEN);
  });

  it('includes the wallet help block with the three install links, the USDC top-up and the phone note', () => {
    for (const href of ['https://phantom.com/download', 'https://solflare.com/download', 'https://backpack.app/downloads']) expect(h).toContain(`href="${href}"`);
    expect(h).toContain('id="wallet"');
    expect(text(h)).toContain(l === 'de' ? '24 Stunden' : '24 hours');
  });

  it('emits FAQPage structured data that matches the section', () => {
    const faq = ldBlocks(h).find((b) => b['@type'] === 'FAQPage');
    expect(faq.mainEntity).toHaveLength(questions.length);
    expect(faq.mainEntity[0]).toMatchObject({ '@type': 'Question', acceptedAnswer: { '@type': 'Answer' } });
    expect(faq.inLanguage).toBe(l);
  });
});

describe.each(LOCALES)('how it works section (%s)', (l) => {
  const h = html(React.createElement(HowSections, { locale: l }));

  it('is the six steps with their roles, a link to the wallet help and one to the proof section', () => {
    expect(h).toContain('id="how"');
    expect(h.match(/<h1/g)).toBeNull();
    expect(h.match(/<h3>/g)).toHaveLength(6);
    expect(h).toContain('href="#wallet"');
    expect(h).toContain('href="#verify"');
    expect(h).toContain(`href="/${l}/sell"`);
    expect(h).not.toContain('<details');
  });
});

describe('the old routes', () => {
  it('are gone as pages (they redirect, see src/lib/__tests__/old-routes.test.ts)', () => {
    for (const d of ['faq', 'how-it-works', 'pitch']) expect(fs.existsSync(path.join(process.cwd(), 'src/app/[locale]', d)), d).toBe(false);
  });
});

describe('wallet help', () => {
  it.each(LOCALES)('links each wallet, says how to get USDC and what to do on a phone, with no test-network wording (%s)', (l) => {
    const h = html(React.createElement(WalletHelp, { locale: l }));
    const w = getExplainMessages(l).walletHelp;
    expect(h).toContain(w.heading);
    expect(h).toContain(esc(w.mobile));
    expect(text(h)).toContain('USDC');
    expect(text(h)).not.toMatch(FORBIDDEN);
    expect(h.match(/rel="noopener noreferrer"/g)).toHaveLength(3);
    expect(h).toContain(`href="/${l}/about#faq"`);
  });
});

describe('explain panels', () => {
  it('has copy and an icon for every panel and FAQ entry of the explain bubble in both languages', () => {
    for (const l of LOCALES) {
      const m = getExplainMessages(l);
      for (const k of PANEL_KEYS) {
        expect(m.panels[k].title.length, `${l}.${k}`).toBeGreaterThan(3);
        expect(PANEL_ICONS[k], k).toBeDefined();
      }
      for (const k of FAQ_KEYS) expect(m.faq[k].a.length).toBeGreaterThan(10);
    }
  });
});
