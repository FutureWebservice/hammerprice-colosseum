/**
 * Where the help pieces are built in, checked in the source (no DOM library is installed, so clicks and focus are not run).
 * A page that loses its anchor or its mount would leave the tour pointing at nothing, so this fails first.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SELL_TOUR_STEPS, TOUR_STEPS } from '../steps';

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');

describe('tour anchors exist in the room and the wizard', () => {
  const where: Record<string, string> = {
    stage: 'src/components/auction/Stage.tsx',
    clock: 'src/components/room/PhaseBanner.tsx',
    bid: 'src/components/auction/BidControl.tsx',
    rail: 'src/components/auction/CatalogueRail.tsx',
    help: 'src/components/tour/HelpMenu.tsx',
    'sell-steps': 'src/components/sell/WizardViews.tsx',
    'sell-nav': 'src/components/sell/WizardViews.tsx',
    'sell-step': 'src/components/sell/Wizard.tsx',
  };
  it('every step has an element carrying its data-tour value', () => {
    for (const s of [...TOUR_STEPS, ...SELL_TOUR_STEPS]) {
      const file = where[s.anchor];
      expect(file, `no file listed for ${s.anchor}`).toBeTruthy();
      expect(src(file!), `${file} has no data-tour="${s.anchor}"`).toContain(`data-tour="${s.anchor}"`);
    }
  });
  it('the room, the practice room and the wizard mount their tour once', () => {
    expect(src('src/components/auction/AuctionRoom.tsx').match(/<Tour\b/g)).toHaveLength(1);
    expect(src('src/components/auction/PracticeRoom.tsx').match(/<Tour\b/g)).toHaveLength(1);
    expect(src('src/components/sell/Wizard.tsx')).toMatch(/<Tour flow="sell" \/>/);
  });
});

describe('help is reachable from every page', () => {
  it('the one site header holds the Help button (the room uses it compact); the phone menu lists the same pages', () => {
    expect(src('src/components/room/RoomShell.tsx')).not.toContain('<HelpMenu');
    expect(src('src/components/layout/SiteChrome.tsx')).toContain('<Header compact />');
    const header = src('src/components/layout/Header.tsx');
    expect(header).toContain('<HelpMenu />');
    for (const target of ['/about#glossary', '/about#wallet', '/about#faq']) expect(header, target).toContain(`'${target}'`);
  });
  it('the About page holds the glossary (id="glossary") and the wallet help (id="wallet") in its FAQ section', () => {
    const faq = src('src/components/explain/FaqSections.tsx');
    expect(faq).toContain('<GlossaryList');
    expect(faq).toContain('<WalletHelp');
    expect(src('src/components/explain/AboutPage.tsx')).toContain('<FaqSections');
    for (const f of ['src/components/tour/HelpMenu.tsx']) for (const target of ['/about#glossary', '/about#wallet', '/about#faq']) expect(src(f), target).toContain(target);
  });
  it('the first Tab stop of a page outside the room is the skip link, and the target exists', () => {
    expect(src('src/components/layout/SiteChrome.tsx')).toContain("'#main-content'");
    expect(src('src/components/layout/SiteChrome.tsx')).toContain("'#ar-bidding'");
    expect(src('src/app/[locale]/layout.tsx')).toContain('id="main-content"');
  });
});

describe('the wallet hints sit above the buttons that open the wallet', () => {
  it('sign-in, bidding number, payment and card check', () => {
    expect(src('src/components/room/GetReadySheet.tsx')).toContain('kind="signin"');
    expect(src('src/components/room/GetReadySheet.tsx')).toContain('kind="paddle"');
    expect(src('src/components/room/PayModal.tsx')).toContain('kind="pay"');
    expect(src('src/components/sell/WizardViews.tsx')).toContain('kind="consign"');
    expect(src('src/components/sell/SignInGate.tsx')).toContain('kind="signin"');
  });
  it('a confirmed prompt turns the note into one quiet line', () => {
    expect(src('src/components/auction/AuctionRoom.tsx')).toContain("markHintConfirmed('signin')");
    expect(src('src/components/auction/AuctionRoom.tsx')).toContain("markHintConfirmed('paddle')");
    expect(src('src/components/room/PayModal.tsx')).toContain("markHintConfirmed('pay')");
    expect(src('src/components/sell/Wizard.tsx')).toContain("markHintConfirmed('consign')");
  });
  it('the AI credits hint is not mounted here: that feature is built into its own package', () => {
    for (const f of ['src/components/room/GetReadySheet.tsx', 'src/components/room/PayModal.tsx', 'src/components/sell/WizardViews.tsx']) expect(src(f)).not.toContain('kind="credits"');
  });
});

describe('storage: no key beyond the three the cookies table already lists', () => {
  it('the tour, hint and Advanced code write only hp.tour.v1, hp.hint.* and hp.adv.*', () => {
    const files = ['src/components/tour/tour-logic.ts', 'src/components/explain/WalletPromptHint.tsx', 'src/components/explain/Advanced.tsx'];
    const keys = files.flatMap((f) => [...src(f).matchAll(/['"`](hp\.[a-z]+[.\w$]*)/g)].map((m) => m[1]!));
    for (const k of keys) expect(k, k).toMatch(/^hp\.(tour\.v1|hint\.|adv\.)/);
  });
  it('the new code in this package writes no storage of its own', () => {
    for (const f of ['src/components/tour/steps.ts', 'src/components/tour/useTour.ts', 'src/lib/client/features.ts', 'src/components/layout/SiteChrome.tsx']) {
      expect(src(f), f).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    }
  });
});

describe('the navigation shows a feature only where it is on', () => {
  it('the packs link comes from the build-time flag and is absent otherwise', () => {
    expect(src('src/components/layout/Header.tsx')).toContain('packsNavOn()');
    expect(src('src/lib/client/features.ts')).toContain("process.env.NEXT_PUBLIC_FEATURE_PACKS === 'true'");
  });
});

describe('"Replay the tour" is offered only where a tour is mounted', () => {
  it('Tour marks the page and HelpMenu shows the entry only then', () => {
    expect(src('src/components/tour/Tour.tsx')).toContain('setTourMounted(true)');
    const menu = src('src/components/tour/HelpMenu.tsx');
    expect(menu).toContain('tourMounted()');
    expect(menu).toContain('canReplay &&');
  });
});
