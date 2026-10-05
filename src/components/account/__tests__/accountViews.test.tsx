import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/i18n', () => ({
  Link: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a>,
  useRouter: () => ({ push: () => {} }),
}));

import type { RouteResponse, MeResponse } from '@/contracts/api';
import type { SettlementView } from '@/contracts/chain';
import { html, tag, count, isDisabled } from '../../sell/__tests__/harness';
import { fixture } from '../../sell/__tests__/fetchStub';
import {
  ConsignmentsList, DeskBanner, DeskList, FundsPanel, PaddlesList, PagedList, WinsList, type FaucetUi,
} from '../AccountViews';
import { TABS, advancedFromHash, tabFromHash, visibleTabs } from '../Account';
import type { PendingSettlement } from '../desk';

process.env.TZ = 'Europe/Berlin';
const ME = fixture<MeResponse>('me');
const PENDING = ME.pending as PendingSettlement[];
const open = fixture<SettlementView>('settlement-round-open');
const NOW = Date.parse('2026-10-05T18:00:00Z');

describe('paged lists', () => {
  const render = (state: Parameters<typeof PagedList<number>>[0]['state']) =>
    html(<PagedList state={state} onRetry={() => {}} onMore={() => {}} empty="Nothing here">{(items) => <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>}</PagedList>);
  it('loading, error with retry, empty', () => {
    expect(render({ status: 'loading' })).toContain('data-testid="tab-loading"');
    expect(render({ status: 'error', error: { ok: false, status: 500, code: 'unknown', reason: '' } })).toContain('data-testid="tab-error"');
    expect(render({ status: 'ready', items: [], nextCursor: null, more: false, moreError: null })).toContain('Nothing here');
  });
  it('shows the list and a load-more button only when there is a next page', () => {
    const more = render({ status: 'ready', items: [1, 2], nextCursor: 'c', more: false, moreError: null });
    expect(more).toContain('<li>2</li>');
    expect(tag(more, 'load-more')).not.toBeNull();
    expect(render({ status: 'ready', items: [1], nextCursor: null, more: false, moreError: null })).not.toContain('load-more');
    expect(isDisabled(render({ status: 'ready', items: [1], nextCursor: 'c', more: true, moreError: null }), 'load-more')).toBe(true);
  });
});

describe('wins, consignments', () => {
  const wins: Extract<RouteResponse<'meActivity'>, { tab: 'wins' }>['items'] = [
    { lotId: 'l1', lotName: 'Won and paid', gross: '120000000', settlementId: 's1', status: 'settled', explorerUrl: null },
    { lotId: 'l2', lotName: 'Waiting', gross: '50000000', settlementId: 's2', status: 'awaiting_payment', explorerUrl: null },
    { lotId: 'l3', lotName: 'Lapsed', gross: '10000000', settlementId: 's3', status: 'expired', explorerUrl: null },
  ];
  it('wins show the payment status, an explorer receipt once on chain, and a signing link while one is open', () => {
    const receipts = { s1: { ...open, id: 's1', status: 'settled', txSignature: '5'.repeat(88), explorerUrl: 'https://explorer.solana.com/tx/abc?cluster=devnet' } as SettlementView };
    const m = html(<WinsList items={wins} receipts={receipts} />);
    expect(count(m, 'win-row')).toBe(3);
    expect(m).toContain('Done. The card is in your wallet.');
    expect(m).toContain('Pay now to get your card');
    expect(m).toContain('Not completed. The time ran out.');
    expect(tag(m, 'win-receipt')).toContain('href="https://explorer.solana.com/tx/abc?cluster=devnet"');
    expect(tag(m, 'win-receipt')).toContain('rel="noopener noreferrer"');
    expect(count(m, 'win-receipt')).toBe(1);
    expect(count(m, 'win-sign')).toBe(1); // only the open one
    expect(tag(m, 'win-sign')).toContain('href="/verify/l2"'); // no show known: the audit page is the fallback
    expect(m).toContain('>Pay now<');
    const withShow = html(<WinsList items={[wins[1]]} receipts={{}} pending={[{ ...PENDING[0], settlementId: 's2', lotId: 'l2', showId: '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10' }]} />);
    expect(tag(withShow, 'win-sign')).toContain('href="/room/3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10?settle=s2"');
  });
  it('uses the explorer link the server sends with the win when no receipt was read', () => {
    const m = html(<WinsList items={[{ ...wins[0], explorerUrl: 'https://explorer.solana.com/tx/win1?cluster=devnet' }]} />);
    expect(tag(m, 'win-receipt')).toContain('href="https://explorer.solana.com/tx/win1?cluster=devnet"');
  });
  it('builds the receipt link itself when the server sends a signature without a url', () => {
    const m = html(<WinsList items={[wins[0]]} receipts={{ s1: { ...open, id: 's1', txSignature: '5'.repeat(88) } as SettlementView }} />);
    expect(tag(m, 'win-receipt')).toContain(`href="https://explorer.solana.com/tx/${'5'.repeat(88)}?cluster=devnet"`);
  });
  it('consignments show the lot state and the readiness of the card', () => {
    const m = html(<ConsignmentsList items={[{ lotId: 'l', lotName: 'Card', mint: 'M'.repeat(44), state: 'catalogued', consign: 'ready' }]} />);
    expect(m).toContain('Waiting');
    expect(m).toContain('Ready');
    expect(m).toContain('MMMM…MMMM');
  });
});

describe('to do (the settlement desk in plain words)', () => {
  it('shows one short notice for anything open, with the strike rule for a seller and a button to the tab', () => {
    expect(html(<DeskBanner pending={[]} />)).toBe('');
    const buyer = html(<DeskBanner pending={PENDING} onOpen={() => {}} />);
    expect(buyer).toContain('data-testid="desk-banner"');
    expect(buyer).toContain('You have 1 thing to do');
    expect(tag(buyer, 'banner-open')).not.toBeNull();
    expect(buyer).not.toContain('strike');
    const seller = html(<DeskBanner pending={[{ ...PENDING[0], role: 'seller' }, PENDING[0]]} />);
    expect(seller).toContain('You have 2 things to do');
    expect(seller).toContain('gets a strike');
    expect(seller).not.toContain('banner-open');
  });

  it('tells a buyer what they won and what to press: "Pay now so the card moves to your wallet"', () => {
    const m = html(<DeskList pending={PENDING} views={{}} nowMs={NOW} names={{ [PENDING[0].lotId]: 'Charizard ex' }} />);
    expect(m).toContain('You won Charizard ex for 120.00 USDC. Pay now so the card moves to your wallet.');
    expect(tag(m, 'sign-link')).toContain(`href="/room/${PENDING[0].showId}?settle=${PENDING[0].settlementId}"`);
    expect(m).toContain('>Pay now<');
    expect(m).not.toContain('jargon');
    for (const jargon of ['paddle', 'settlement', 'round', 'reserve', 'hash']) expect(m.toLowerCase().replace(/data-[a-z-]+="[^"]*"/g, '')).not.toContain(jargon);
  });

  it('tells a seller to deliver, with a Deliver now button, and says when the other side already did their part', () => {
    const seller: PendingSettlement = { ...PENDING[0], role: 'seller', showId: '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10' };
    const m = html(<DeskList pending={[seller]} views={{ [seller.settlementId]: open }} nowMs={NOW} names={{ [seller.lotId]: 'Blastoise' }} />);
    expect(tag(m, 'sign-request')).toContain('data-role="seller"');
    expect(tag(m, 'sign-link')).toContain(`href="/room/3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10?settle=${seller.settlementId}"`);
    expect(m).toContain('Blastoise sold for 120.00 USDC. Deliver now');
    expect(m).toContain('>Deliver now<');
    expect(m).toContain('Time left: 15:56');
    expect(m).toContain('The other side is ready. It is your turn.');
  });
  it('keeps the signing round facts one click away under Details', () => {
    const m = html(<DeskList pending={PENDING} views={{ [PENDING[0].settlementId]: open }} nowMs={NOW} />);
    const details = m.slice(m.indexOf('data-testid="desk-details"'));
    expect(details).toContain('Buyer signed');
    expect(details).toContain('Seller has not signed');
    expect(details).toContain('Signing round closes in 02:00');
    expect(m).toContain('You won a card for');
  });
  it('says when you are done and when the time has run out', () => {
    const done = html(<DeskList pending={PENDING} views={{ [PENDING[0].settlementId]: { ...open, buyerSigned: true, sellerSigned: false } }} nowMs={NOW} />);
    expect(done).toContain('You are done. Waiting for the other side.');
    const late = html(<DeskList pending={PENDING} views={{}} nowMs={Date.parse('2026-10-05T19:00:00Z')} />);
    expect(late).toContain('The time has run out.');
    expect(late).not.toContain('data-testid="round-state"');
  });
  it('speaks German in the same tone', () => {
    const m = html(<DeskList pending={PENDING} views={{}} nowMs={NOW} names={{ [PENDING[0].lotId]: 'Glurak' }} />, 'de');
    expect(m).toContain('Sie haben Glurak für 120,00 USDC gewonnen. Bezahlen Sie jetzt');
    expect(m).toContain('Jetzt bezahlen');
  });
  it('has an empty state', () => {
    expect(html(<DeskList pending={[]} views={{}} nowMs={NOW} />)).toContain('data-testid="desk-empty"');
  });
  it('sorts the soonest deadline first', () => {
    const a: PendingSettlement = { ...PENDING[0], settlementId: 'late', dueAt: '2026-10-05T20:00:00Z' };
    const b: PendingSettlement = { ...PENDING[0], settlementId: 'soon', dueAt: '2026-10-05T18:10:00Z' };
    const m = html(<DeskList pending={[a, b]} views={{}} nowMs={NOW} />);
    expect(m.indexOf('Time left: 10:00')).toBeGreaterThan(-1);
    expect(m.indexOf('Time left: 10:00')).toBeLessThan(m.indexOf('Time left: 02:00:00'));
  });
});

describe('paddles', () => {
  const show = { id: '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10', title: 'House show', status: 'live' as const, scheduledAt: null, startedAt: null, lotCount: 1, soldCount: 0, hammerTotal: '0', cluster: 'devnet' as const, isHouse: true, thumbs: [], endedAt: null, kind: 'live' as const };
  it('lists a paddle with its number, validity and funding, and a release button', () => {
    const m = html(<PaddlesList state={{ status: 'ready', rows: [{ show, number: 7, validUntil: '2026-10-06T00:00:00Z', funded: true }] }} onRelease={() => {}} onRetry={() => {}} />);
    expect(tag(m, 'paddle-number')).not.toBeNull();
    expect(m).toContain('>7<');
    expect(m).toContain('Funded');
    expect(tag(m, 'release-paddle')).not.toBeNull();
  });
  it('empty, loading and error states', () => {
    const r = (state: Parameters<typeof PaddlesList>[0]['state']) => html(<PaddlesList state={state} onRelease={() => {}} onRetry={() => {}} />);
    expect(r({ status: 'ready', rows: [] })).toContain('You register one inside the room');
    expect(r({ status: 'loading' })).toContain('Loading');
    expect(r({ status: 'error', error: { ok: false, status: 0, code: 'network', reason: '' } })).toContain('data-testid="tab-error"');
  });
});

describe('test funds', () => {
  const funds = (ui: FaucetUi, usdc: string | null = '1000000000', devnet = true, locale: 'en' | 'de' = 'en') =>
    html(<FundsPanel devnet={devnet} funds={{ usdc }} ui={ui} onClaim={() => {}} />, locale);

  it('explains tUSDC as a test token and that no SOL is needed, with a faucet button and the balance', () => {
    const m = funds({ kind: 'idle' });
    expect(tag(m, 'faucet-button')).not.toBeNull();
    expect(m).toContain('tUSDC is a free test token');
    expect(m).toContain('do not need any SOL');
    expect(m).toContain('1,000.00 USDC');
  });
  it('says so when the balance cannot be read (the RPC is down)', () => {
    expect(funds({ kind: 'idle' }, null)).toContain('Not available right now');
  });
  it('disables the button while sending and links the receipt after success', () => {
    expect(isDisabled(funds({ kind: 'busy' }), 'faucet-button')).toBe(true);
    const m = funds({ kind: 'done', amount: '1000000000', signature: '5'.repeat(88) });
    expect(m).toContain('Sent 1,000.00 USDC to your wallet.');
    expect(m).toContain(`https://explorer.solana.com/tx/${'5'.repeat(88)}?cluster=devnet`);
  });
  it.each([
    ['rate_limited', '3 hours', 'Try again in 3 hours'],
    ['faucet_paused', undefined, 'paused right now'],
    ['not_found', undefined, 'only exists on devnet'],
    ['rpc_unavailable', undefined, 'could not send test USDC'],
  ])('answers %s in plain words', (code, wait, words) => {
    const m = funds({ kind: 'fail', code, wait });
    expect(tag(m, 'faucet-error')).toContain(`data-code="${code}"`);
    expect(m).toContain(words);
  });
  it('speaks German and hides the faucet off devnet', () => {
    expect(funds({ kind: 'fail', code: 'rate_limited', wait: '3 Stunden' }, '0', true, 'de')).toContain('Versuchen Sie es in 3 Stunden erneut');
    const m = funds({ kind: 'idle' }, '0', false);
    expect(m).toContain('data-testid="funds-mainnet"');
    expect(m).not.toContain('faucet-button');
  });
});

describe('the tabs and the url hash', () => {
  it('has nine sections; AI credits is the only one that can be hidden', () => {
    expect(TABS).toEqual(['profile', 'wallet', 'bids', 'payments', 'sales', 'prices', 'credits', 'notifications', 'account']);
    expect(visibleTabs('ready')).toEqual([...TABS]);
    for (const hidden of ['hidden', 'loading'] as const) expect(visibleTabs(hidden)).toEqual(TABS.filter((t) => t !== 'credits'));
  });
  it('opens the named tab, keeps the old links working and returns null for anything else', () => {
    expect(tabFromHash('#funds')).toBe('wallet');
    expect(tabFromHash('#wallet')).toBe('wallet');
    expect(tabFromHash('#todo')).toBe('payments');
    expect(tabFromHash('desk')).toBe('payments');
    expect(tabFromHash('#tasks')).toBe('payments');
    expect(tabFromHash('#wins')).toBe('payments');
    expect(tabFromHash('#bids')).toBe('bids');
    expect(tabFromHash('#activity')).toBe('bids');
    expect(tabFromHash('#consignments')).toBe('sales');
    expect(tabFromHash('#telegram')).toBe('notifications');
    expect(tabFromHash('#nope')).toBeNull();
    expect(tabFromHash('')).toBeNull();
  });
  it('opens the bidder numbers for #paddles and #advanced', () => {
    for (const h of ['#advanced', '#paddles']) { expect(advancedFromHash(h)).toBe(true); expect(tabFromHash(h)).toBe('bids'); }
    expect(advancedFromHash('#funds')).toBe(false);
    expect(advancedFromHash('consignments')).toBe(false);
  });
});
