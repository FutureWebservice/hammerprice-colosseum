/**
 * With prefers-reduced-motion the opening shows the card at once: no pack, no burst, the card face up and no skip button. (The hook is
 * replaced here; the real media query is exercised in the browser test e17.)
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/locales/en/packs.json';

(globalThis as unknown as { React: typeof React }).React = React; // no automatic JSX runtime in the test transform
vi.mock('../useReducedMotion', () => ({ useReducedMotion: () => true }));

import RevealStage from '../RevealStage';
import { RARITY_LEVELS } from '@/lib/packs/rarity';

describe('RevealStage with reduced motion', () => {
  for (const rarity of RARITY_LEVELS) {
    it(`${rarity}: face up from the first paint, nothing to skip`, () => {
      const html = renderToStaticMarkup(
        <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ packs: enMessages }}>
          <RevealStage card={{ name: 'Card A', imageUrl: null }} rarity={rarity} odds={[{ tier: 'a', bps: 10000 }]} count={6} packName="P" packSeed="s" sfx={null} labels={{ sealed: 'Sealed', tearing: 'Opening', shown: 'Face up', skip: 'Skip' }} />
        </NextIntlClientProvider>,
      );
      expect(html).toContain('data-reduced="true"');
      expect(html).toContain('data-phase="shown"');
      expect(html).toContain('data-flipped="true"');
      expect(html).not.toContain('reveal-skip');
      expect(html).toContain('role="status"');
    });
  }
});
