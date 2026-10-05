/**
 * The profile page's sections as markup: header, picture, wallet and cards, bids, rooms, sold lots, prices, credits, notifications, the danger zone.
 * Every loading, error, empty and filled state, in both languages. No DOM library: states render to static markup and are read by data-testid.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/i18n', () => ({
  Link: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a>,
  useRouter: () => ({ push: () => {} }),
}));

import type { SellAsset, ShowSummary } from '@/contracts/api';
import type { ProfileView, SummaryResponse, WalletResponse } from '@/contracts/profile';
import { html, tag, count } from '../../sell/__tests__/harness';
import { Avatar, Identicon, ProfileHeaderView } from '../ProfileHeader';
import { AvatarEditorView } from '../ProfileEditor';
import { BidSections, CardsView, CreditsView, DangerZone, NotificationsIntro, PricesView, RoomsList, SoldLots, WalletBalances } from '../DashboardViews';
import type { Load } from '../useProfileData';

process.env.TZ = 'Europe/Berlin';
const ID = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10';
const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const profile: ProfileView = { id: ID, username: 'anna_7', displayName: 'Anna Cards', bio: 'Graded PSA only.', avatarUrl: null, avatar: null, createdAt: '2026-09-01T10:00:00Z', strikes: 1 };
const ready = <T,>(data: T): Load<T> => ({ status: 'ready', data });
const failed: Load<never> = { status: 'error', error: { ok: false, status: 500, code: 'unknown', reason: '' } };
const loading: Load<never> = { status: 'loading' };

describe('header', () => {
  const header = (p: Load<ProfileView>, locale: 'en' | 'de' = 'en', copy: 'idle' | 'copied' | 'failed' = 'idle') => html(<ProfileHeaderView profile={p} wallet={WALLET} copy={copy} onCopy={() => {}} />, locale);

  it('shows the username, display name, bio, the whole wallet address with copy and an explorer link, member since and strikes', () => {
    const m = header(ready(profile));
    expect(tag(m, 'header-username')).not.toBeNull();
    expect(m).toContain('anna_7');
    expect(m).toContain('Anna Cards');
    expect(m).toContain('Graded PSA only.');
    expect(m).toContain(`>${WALLET}<`);
    expect(tag(m, 'copy-wallet')).toContain('type="button"');
    expect(tag(m, 'wallet-explorer')).toContain(`href="https://explorer.solana.com/address/${WALLET}`);
    expect(tag(m, 'wallet-explorer')).toContain('rel="noopener noreferrer"');
    expect(m).toContain('Member since');
    expect(m).toContain('September 1, 2026');
    expect(m).toContain('1 of 20');
    expect(m).toContain('At 20 warnings your bidding number is suspended.');
  });

  it('says so when there is no username, and shows nothing for a missing display name or bio', () => {
    const m = header(ready({ ...profile, username: null, displayName: null, bio: null }));
    expect(m).toContain('No username yet');
    expect(m).not.toContain('header-display-name');
    expect(m).not.toContain('header-bio');
  });

  it('announces the outcome of Copy in a status region, and tells a failure in words', () => {
    expect(header(ready(profile), 'en', 'copied')).toContain('Address copied.');
    expect(tag(header(ready(profile)), 'copy-status')).toContain('role="status"');
    expect(header(ready(profile), 'en', 'failed')).toContain('Could not copy.');
  });

  it('has a loading state and an error state with its own role', () => {
    expect(tag(header(loading), 'header-loading')).toContain('role="status"');
    expect(tag(header(failed), 'header-error')).toContain('role="alert"');
  });

  it('speaks German in the Sie form', () => {
    const m = header(ready(profile), 'de');
    for (const w of ['Wallet-Adresse', 'Adresse kopieren', 'Im Explorer ansehen', 'Mitglied seit', '1. September 2026', 'Verwarnungen', '1 von 20']) expect(m, w).toContain(w);
    expect(m).not.toContain('Member since');
  });
});

describe('picture', () => {
  it('shows the uploaded picture from the cached route with its version, else the old address, else a generated identicon', () => {
    const up = html(<Avatar profile={{ ...profile, avatar: { version: 1790000000000 } }} />);
    expect(tag(up, 'avatar-image')).toContain(`src="/api/avatar/${ID}?v=1790000000000"`);
    expect(tag(up, 'avatar-image')).toContain('alt=""');
    const old = html(<Avatar profile={{ ...profile, avatarUrl: 'https://d1.cloudfront.net/a.png' }} />);
    expect(tag(old, 'avatar-image')).toContain('src="https://d1.cloudfront.net/a.png"');
    expect(tag(old, 'avatar-image')).toContain('referrerPolicy="no-referrer"');
    const none = html(<Avatar profile={profile} />);
    expect(tag(none, 'identicon')).toContain('aria-hidden="true"');
    expect(none).not.toContain('avatar-image');
  });

  it('the identicon is the same for the same profile and differs between profiles', () => {
    const a = html(<Identicon seed={ID} />);
    expect(html(<Identicon seed={ID} />)).toBe(a);
    expect(html(<Identicon seed="0b7e0f3a-6c1d-4a7e-9a3f-5b2c8d9e1f00" />)).not.toBe(a);
  });

  const editor = (o: { avatar?: ProfileView['avatar']; status?: 'idle' | 'busy' | 'done' | 'removed' | 'error'; message?: string | null; locale?: 'en' | 'de' } = {}) =>
    html(<AvatarEditorView profile={{ ...profile, avatar: o.avatar ?? null }} status={o.status ?? 'idle'} message={o.message ?? null} onPick={() => {}} onRemove={() => {}} />, o.locale ?? 'en');

  it('offers a file chooser limited to png, jpeg and webp, with the rules in a description, and no Remove while there is no uploaded picture', () => {
    const m = editor();
    expect(tag(m, 'avatar-file')).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(tag(m, 'avatar-file')).toContain('aria-hidden="true"'); // the browser's file dialog only, out of the tab order
    expect(tag(m, 'avatar-file')).toContain('tabindex="-1"');
    expect(tag(m, 'avatar-choose')).toContain('aria-describedby="avatar-hint"'); // the visible button is the labelled control
    expect(m).toContain('png, jpeg or webp, up to 200 KB. No SVG.');
    expect(m).not.toContain('avatar-remove');
    expect(editor({ avatar: { version: 1 } })).toContain('avatar-remove');
  });

  it('disables the buttons while uploading and announces the outcome in a status region', () => {
    const busy = editor({ status: 'busy' });
    expect(tag(busy, 'avatar-choose')).toContain('disabled');
    expect(busy).toContain('Uploading...');
    expect(tag(editor({ status: 'error', message: 'That picture is larger than 200 KB. Choose a smaller one.' }), 'avatar-message')).toContain('role="status"');
    expect(editor({ locale: 'de' })).toContain('png, jpeg oder webp, bis 200 KB. Kein SVG.');
  });
});

describe('wallet and cards', () => {
  const wallet: WalletResponse = { wallet: WALLET, cluster: 'devnet', sol: '1234500000', usdc: '250500000' };
  it('shows SOL, USDC and what is available for bids, per language', () => {
    const m = html(<WalletBalances wallet={ready(wallet)} available="200000000" />);
    expect(tag(m, 'balance-sol')).not.toBeNull();
    expect(m).toContain('1.2345 SOL');
    expect(m).toContain('250.50 USDC');
    expect(m).toContain('200.00 USDC');
    expect(m).toContain('Network: devnet');
    const de = html(<WalletBalances wallet={ready(wallet)} available="200000000" />, 'de');
    expect(de).toContain('1,2345 SOL');
    expect(de).toContain('250,50 USDC');
    expect(de).toContain('Für Gebote verfügbar');
  });
  it('says "not available" instead of a number when the network does not answer, and offers a retry on an error', () => {
    const m = html(<WalletBalances wallet={ready({ ...wallet, sol: null, usdc: null })} available={null} />);
    expect(count(m, 'balance-sol')).toBe(1);
    expect(m.match(/Not available right now/g)).toHaveLength(3);
    expect(html(<WalletBalances wallet={failed} available={null} onRetry={() => {}} />)).toContain('data-testid="section-error"');
    expect(html(<WalletBalances wallet={loading} available={null} />)).toContain('data-testid="section-loading"');
  });

  const card = (o: Partial<SellAsset>): SellAsset => ({ mint: 'M'.repeat(44), name: 'Charizard 1999', imageUrl: 'https://img.example/c.png', grade: 'PSA 10', standard: 'core', eligible: true, reasons: [], consign: 'none', ...o } as SellAsset);
  it('lists the cards with image, name and grade, and a Sell this card link into the wizard only for a card that can be sold', () => {
    const m = html(<CardsView state={{ status: 'ready', assets: [card({}), card({ mint: 'N'.repeat(44), name: 'Pikachu', eligible: false, reasons: ['frozen'] })] }} />);
    expect(count(m, 'wallet-card')).toBe(2);
    expect(m).toContain('Charizard 1999');
    expect(m).toContain('PSA 10');
    expect(tag(m, 'sell-card')).toContain('href="/sell/new"');
    expect(count(m, 'sell-card')).toBe(1);
    expect(count(m, 'card-not-sellable')).toBe(1);
    expect(m).toContain('Sell this card');
    expect(html(<CardsView state={{ status: 'ready', assets: [card({})] }} />, 'de')).toContain('Diese Karte verkaufen');
  });
  it('has an empty state, a loading state and an error state with its own words', () => {
    expect(html(<CardsView state={{ status: 'ready', assets: [] }} />)).toContain('No cards found in your wallet.');
    expect(html(<CardsView state={{ status: 'loading' }} />)).toContain('data-testid="section-loading"');
    expect(html(<CardsView state={{ status: 'error', error: { ok: false, status: 503, code: 'rpc_unavailable', reason: '' } }} />)).toContain('We could not read the cards in your wallet right now.');
  });
});

describe('bids', () => {
  const bid = (o: Partial<Parameters<typeof BidSections>[0]['items'][number]>) => ({ bidId: 'b', lotId: 'l', lotName: 'Lot', amount: '60000000', placedAt: '2026-10-05T17:00:00Z', leading: false, closesAt: null, lotState: 'open' as const, result: 'outbid' as const, ...o });
  it('splits active bids (the lot is still open) from the history, and says what became of each', () => {
    const items = [
      bid({ bidId: '1', lotName: 'Leading lot', leading: true, result: 'leading' }),
      bid({ bidId: '2', lotName: 'Outbid lot' }),
      bid({ bidId: '3', lotName: 'Won lot', lotState: 'sold', result: 'won' }),
      bid({ bidId: '4', lotName: 'Lost lot', lotState: 'sold', result: 'lost' }),
      bid({ bidId: '5', lotName: 'Closed lot', lotState: 'passed', result: 'ended' }),
    ];
    const m = html(<BidSections items={items} />);
    const active = m.slice(m.indexOf('data-testid="bids-active"'), m.indexOf('data-testid="bids-history"'));
    expect(count(active, 'bid-row')).toBe(2);
    expect(active).toContain('Leading lot');
    expect(active).not.toContain('Won lot');
    const history = m.slice(m.indexOf('data-testid="bids-history"'));
    expect(count(history, 'bid-row')).toBe(3);
    for (const w of ['Won', 'Lost', 'Lot closed without a sale']) expect(history).toContain(w);
    expect(m).toContain('60.00 USDC');
    expect(html(<BidSections items={items} />, 'de')).toContain('Los ohne Verkauf geschlossen');
  });
  it('says there is no active bid when only history exists', () => {
    const m = html(<BidSections items={[bid({ lotState: 'sold', result: 'lost' })]} />);
    expect(m).toContain('You have no active bid right now.');
  });
});

describe('sales', () => {
  const room = (o: Partial<ShowSummary>): ShowSummary => ({ id: ID, title: 'Sunday Slabs', status: 'ended', scheduledAt: '2026-10-04T16:00:00Z', startedAt: '2026-10-04T16:02:00Z', endedAt: '2026-10-04T17:30:00Z', lotCount: 5, soldCount: 3, hammerTotal: '450000000', cluster: 'devnet', isHouse: false, thumbs: [], kind: 'live', ...o });
  it('lists live rooms first, then upcoming, then ended, each with a manage link and an open link', () => {
    const m = html(<RoomsList shows={[
      room({ id: 'a-ended', title: 'Ended room' }),
      room({ id: 'b-sched', title: 'Upcoming room', status: 'scheduled', soldCount: 0, hammerTotal: '0' }),
      room({ id: 'c-live', title: 'Live room', status: 'live' }),
    ]} />);
    const order = [...m.matchAll(/data-status="(\w+)"/g)].map((x) => x[1]);
    expect(order).toEqual(['live', 'scheduled', 'ended']);
    expect(m).toContain('3 of 5 lots sold');
    expect(m).toContain('Total sales 450.00 USDC');
    expect(tag(m, 'room-manage')).toContain('href="/sell/c-live"');
    expect(m).toContain('href="/room/c-live"');
    expect(m).toContain('Manage');
    expect(m.match(/Total sales/g)).toHaveLength(2); // the upcoming room has sold nothing and shows no total
  });
  it('has an empty state, and German words', () => {
    expect(html(<RoomsList shows={[]} />)).toContain('You have not created a room yet.');
    expect(html(<RoomsList shows={[room({})]} />, 'de')).toContain('3 von 5 Losen verkauft');
  });

  const summary: SummaryResponse = {
    bought: { count: 2, totalGross: '150000000', averageGross: '75000000' },
    sold: { count: 3, totalGross: '450000000', totalFees: '9000000', totalPayout: '441000000', averageGross: '150000000', best: { lotName: 'Charizard 1999', gross: '300000000' } },
    recentSales: [{ settlementId: 's1', lotName: 'Charizard 1999', gross: '300000000', fee: '6000000', payout: '294000000', settledAt: '2026-10-04T17:00:00Z', explorerUrl: 'https://explorer.solana.com/tx/abc?cluster=devnet' }],
  };
  it('shows each sold lot with hammer price, fee, payout and the transaction', () => {
    const m = html(<SoldLots summary={ready(summary)} />);
    expect(m).toContain('Charizard 1999');
    expect(m).toContain('300.00 USDC');
    expect(m).toContain('6.00 USDC');
    expect(m).toContain('294.00 USDC');
    expect(tag(m, 'sold-tx')).toContain('href="https://explorer.solana.com/tx/abc?cluster=devnet"');
  });
  it('has an empty and an error state', () => {
    expect(html(<SoldLots summary={ready({ ...summary, recentSales: [] })} />)).toContain('No completed sale yet.');
    expect(html(<SoldLots summary={failed} onRetry={() => {}} />)).toContain('data-testid="section-error"');
  });

  it('prices overview: totals bought and sold, the average hammer price, the best sale, the fees and the payout', () => {
    const m = html(<PricesView summary={ready(summary)} />);
    expect(tag(m, 'prices-bought')).not.toBeNull();
    expect(m).toContain('2 cards');
    expect(m).toContain('150.00 USDC');
    expect(m).toContain('450.00 USDC');
    expect(m).toContain('9.00 USDC');
    expect(m).toContain('441.00 USDC');
    expect(tag(m, 'prices-best')).not.toBeNull();
    expect(m).toContain('Charizard 1999');
    expect(m).toContain('Computed from your completed (settled) purchases and sales only.');
    expect(html(<PricesView summary={ready(summary)} />, 'de')).toContain('Durchschnittlicher Zuschlagspreis');
  });
  it('prices overview: a new account sees one friendly sentence, never zeros or NaN', () => {
    const none: SummaryResponse = { bought: { count: 0, totalGross: '0', averageGross: null }, sold: { count: 0, totalGross: '0', totalFees: '0', totalPayout: '0', averageGross: null, best: null }, recentSales: [] };
    const m = html(<PricesView summary={ready(none)} />);
    expect(m).toContain('No completed purchase or sale yet.');
    expect(m).not.toContain('NaN');
    const onlyBought = html(<PricesView summary={ready({ ...none, bought: summary.bought })} />);
    expect(onlyBought).toContain('None yet'); // no best sale and no sold average yet
  });
});

describe('credits, notifications and the danger zone', () => {
  it('shows the balance, the pack and how many packs are left, with a way to use the credits', () => {
    const m = html(<CreditsView data={{ balance: 7, pack: { credits: 10, priceUsdc: '1000000' }, packsLeftToday: 4, cluster: 'devnet', configured: true }} />);
    expect(tag(m, 'credits-balance')).not.toBeNull();
    expect(m).toContain('>7<');
    expect(m).toContain('One pack: 10 credits for 1.00 USDC');
    expect(m).toContain('Packs left today: 4');
    expect(tag(m, 'credits-open')).toContain('href="/sell/new"');
    expect(html(<CreditsView data={{ balance: 0, pack: { credits: 10, priceUsdc: '1000000' }, packsLeftToday: null, cluster: 'devnet', configured: true }} />)).not.toContain('credits-left');
    expect(html(<CreditsView data={{ balance: 7, pack: { credits: 10, priceUsdc: '1000000' }, packsLeftToday: 4, cluster: 'devnet', configured: true }} />, 'de')).toContain('KI-Guthaben');
  });

  it('notification settings explain where messages come from and link to the payments list', () => {
    const m = html(<NotificationsIntro onPayments={() => {}} />);
    expect(m).toContain('Notification settings');
    expect(m).toContain('Telegram');
    expect(tag(m, 'notifications-payments')).toContain('type="button"');
  });

  it('the danger zone asks twice before it disconnects, and links the privacy policy', () => {
    const ask = html(<DangerZone confirming={false} busy={false} onAsk={() => {}} onConfirm={() => {}} onCancel={() => {}} />);
    expect(tag(ask, 'disconnect')).not.toBeNull();
    expect(ask).not.toContain('disconnect-confirm');
    expect(ask).toContain('href="/legal/datenschutz"');
    const sure = html(<DangerZone confirming busy={false} onAsk={() => {}} onConfirm={() => {}} onCancel={() => {}} />);
    expect(tag(sure, 'disconnect-confirm')).not.toBeNull();
    expect(tag(sure, 'disconnect-cancel')).not.toBeNull();
    expect(tag(html(<DangerZone confirming busy onAsk={() => {}} onConfirm={() => {}} onCancel={() => {}} />), 'disconnect-confirm')).toContain('disabled');
    expect(html(<DangerZone confirming={false} busy={false} onAsk={() => {}} onConfirm={() => {}} onCancel={() => {}} />, 'de')).toContain('Gefahrenbereich');
  });
});
