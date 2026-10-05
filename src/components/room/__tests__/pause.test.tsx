/** The banner of a paused room, in both languages: same words for everyone, a countdown that screen readers do not hear tick. */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enRoom from '@/locales/en/room.json';
import deRoom from '@/locales/de/room.json';
import PauseBanner from '../PauseBanner';

(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

const wrap = (locale: 'en' | 'de', node: React.ReactNode) =>
  renderToStaticMarkup(<NextIntlClientProvider locale={locale} messages={locale === 'en' ? { room: enRoom } : { room: deRoom }} timeZone="UTC">{node}</NextIntlClientProvider>);

describe('PauseBanner', () => {
  it('says the seller paused, that nobody loses time, what the lot keeps and how many pauses are used', () => {
    const m = wrap('en', <PauseBanner msToResume={272_000} msLeft={15_000} used={1} max={2} />);
    expect(m).toContain('data-testid="pause-banner"');
    expect(m).toContain('role="status"');
    expect(m).toContain('The seller paused the room.');
    expect(m).toContain('resumes with the same time left. Nobody loses time.');
    expect(m).toContain('The lot keeps 0:15');
    expect(m).toContain('Pause 1 of 2');
  });

  it('shows a countdown to the automatic resume for the eyes and a stable sentence for screen readers', () => {
    const m = wrap('en', <PauseBanner msToResume={272_000} msLeft={null} used={1} max={2} />);
    expect(m).toMatch(/aria-hidden="true"[^>]*data-testid="pause-countdown"[^>]*>Resumes by itself in 4:32</);
    expect(m).toContain('class="sr-only"');
    expect(m).toContain('The pause ends by itself in about 5 minutes at the latest.');
    expect(wrap('en', <PauseBanner msToResume={20_000} msLeft={null} used={2} max={2} />)).toContain('in about 1 minute at the latest');
    expect(m).not.toContain('The lot keeps'); // no time to show without a deadline
  });

  it('never shows a negative countdown', () => {
    expect(wrap('en', <PauseBanner msToResume={-5000} msLeft={-1} used={1} max={2} />)).toContain('Resumes by itself in 0:00');
  });

  it('speaks German', () => {
    const m = wrap('de', <PauseBanner msToResume={272_000} msLeft={15_000} used={2} max={2} />);
    expect(m).toContain('Der Verkäufer hat den Raum pausiert.');
    expect(m).toContain('Niemand verliert Zeit.');
    expect(m).toContain('Das Los behält 0:15');
    expect(m).toContain('Pause 2 von 2');
    expect(m).toContain('Weiter in 4:32');
    expect(m).toContain('in etwa 5 Minuten von selbst');
    expect(m).not.toContain('The seller paused');
  });
});
