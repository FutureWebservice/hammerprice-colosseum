/**
 * The brass "Read the pitch" ribbon points into the About page's pitch section (the page /pitch moved there) and hides itself on /about,
 * where the pitch is a scroll away.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ pathname: '/en' }));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname }));
vi.mock('@/lib/i18n', () => ({
  Link: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...p }, children),
}));
vi.mock('../ribbon.css', () => ({}));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import PitchRibbon from '../PitchRibbon';

const render = () => renderToStaticMarkup(React.createElement(PitchRibbon, { label: 'Read the pitch' }));

beforeEach(() => { state.pathname = '/en'; });

describe('pitch ribbon', () => {
  it('links to /about#pitch from the landing page, the rooms and the legal pages', () => {
    for (const p of ['/en', '/de/rooms', '/en/legal/impressum']) {
      state.pathname = p;
      const m = render();
      expect(m, p).toContain('href="/about#pitch"');
      expect(m, p).toContain('Read the pitch');
    }
  });

  it('is not shown on the About page itself', () => {
    for (const p of ['/en/about', '/de/about']) {
      state.pathname = p;
      expect(render(), p).toBe('');
    }
  });
});
