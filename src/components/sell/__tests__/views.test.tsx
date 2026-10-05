import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/i18n', () => ({
  Link: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a>,
  useRouter: () => ({ push: () => {} }),
}));

import type { CatalogueLot, LiveSnapshot, SellAsset, ShowCore, ShowSummary } from '@/contracts/api';
import { html, tag, count, isDisabled } from './harness';
import { fixture } from './fetchStub';
import { GateView } from '../SignInGate';
import { AssetsView } from '../SellHome';
import AssetGrid from '../AssetGrid';
import { PickStep, PriceStep, StepBar, TimeStep } from '../WizardViews';
import { ManageView, type ManageHandlers, type Note } from '../Manage';
import { ScheduleView } from '../ScheduleView';
import { mergeLots } from '../manageRules';
import { applyAssets, initialState, markChecking, setAllTerms, setTerm, togglePick, type WizardState } from '../wizardState';

process.env.TZ = 'Europe/Berlin';
const NOW = new Date('2026-10-05T10:00:00Z');
const ASSETS: SellAsset[] = fixture<{ assets: SellAsset[] }>('sell-assets').assets;
const [CORE, PNFT] = ASSETS;

describe('sign-in gate', () => {
  const view = (kind: Parameters<typeof GateView>[0]['kind']) => html(<GateView kind={kind} onSignIn={() => {}} walletButton={<button data-testid="wallet-button">wallet</button>} />);
  it('asks a visitor without a wallet to connect, and says nothing is held', () => {
    const m = view('connect');
    expect(m).toContain('data-testid="wallet-button"');
    expect(m).not.toContain('data-testid="sign-in"');
    expect(m).toContain('never holds your cards or your money');
  });
  it('offers sign-in once connected and says it is not a transaction', () => {
    const m = view('sign');
    expect(tag(m, 'sign-in')).not.toBeNull();
    expect(m).toContain('not a transaction');
  });
  it('disables the button while signing and shows the decline and mismatch warnings', () => {
    expect(isDisabled(view('signing'), 'sign-in')).toBe(true);
    expect(view('rejected')).toContain('declined');
    expect(view('mismatch')).toContain('different wallet');
    expect(view('no_sign')).toContain('cannot sign a message');
    expect(view('loading')).toContain('data-testid="gate-loading"');
  });
  it('speaks German too', () => {
    const m = html(<GateView kind="connect" onSignIn={() => {}} walletButton={null} />, 'de');
    expect(m).toContain('Wallet verbinden');
    expect(m).not.toContain('Connect your wallet');
  });
});

describe('asset picker on /sell', () => {
  const noop = () => {};
  it('shows loading, the rpc error with a retry, and the empty state with the mint slot', () => {
    expect(html(<AssetsView state={{ status: 'loading' }} onRetry={noop} />)).toContain('assets-loading');
    const err = html(<AssetsView state={{ status: 'error', error: { ok: false, status: 503, code: 'rpc_unavailable', reason: 'x' } }} onRetry={noop} />);
    expect(err).toContain('data-testid="assets-error"');
    expect(err).toContain('could not read your wallet');
    const empty = html(<AssetsView state={{ status: 'ready', assets: [] }} onRetry={noop} mintSlot={<i data-testid="mint-slot" />} />);
    expect(empty).toContain('data-testid="assets-empty"');
    expect(empty).toContain('data-testid="mint-slot"');
  });

  it('lists each card with its eligibility and, for the ones that cannot be sold, the reason', () => {
    const m = html(<AssetsView state={{ status: 'ready', assets: ASSETS }} onRetry={noop} />);
    expect(count(m, 'asset-card')).toBe(2);
    expect(m).toContain('2 cards found, 1 eligible to sell.');
    expect(count(m, 'asset-eligible')).toBe(1);
    expect(count(m, 'asset-reasons')).toBe(1);
    expect(m).toContain('Only Metaplex Core cards can be sold for now. This card uses: programmable NFT.');
  });

  it('prints every reason the server can give in plain words', () => {
    const all: SellAsset = { ...PNFT, reasons: ['not_found', 'not_owner', 'frozen', 'royalty_rules_block_transfer', 'foreign_delegate_blocks', 'unsupported_standard'] };
    const m = html(<AssetGrid assets={[all]} />);
    for (const words of ['could not find this card', 'not in your signed-in wallet', 'frozen', 'royalty rules', 'lock on this card', 'Only Metaplex Core']) expect(m).toContain(words);
  });

  it('has no pick buttons on the read-only list', () => {
    expect(count(html(<AssetGrid assets={ASSETS} />), 'pick-card')).toBe(0);
  });
});

describe('pickable grid in the wizard', () => {
  it('marks a picked card pressed, disables a card that is not eligible', () => {
    const m = html(<AssetGrid assets={ASSETS} picked={new Set([CORE.mint])} onToggle={() => {}} />);
    const buttons = m.match(/<button[^>]*data-testid="pick-card"[^>]*>/g)!;
    expect(buttons[0]).toContain('aria-pressed="true"');
    expect(buttons[0]).not.toContain('disabled');
    expect(buttons[1]).toContain('disabled');
  });
  it('disables every unpicked card once the maximum is reached but not the picked ones', () => {
    const two = [CORE, { ...CORE, mint: 'B'.repeat(44), name: 'Second' }];
    const m = html(<AssetGrid assets={two} picked={new Set([CORE.mint])} onToggle={() => {}} max={1} />);
    const buttons = m.match(/<button[^>]*data-testid="pick-card"[^>]*>/g)!;
    expect(buttons[0]).not.toContain('disabled');
    expect(buttons[1]).toContain('disabled');
  });
  it('the pick step counts picks and explains when nothing can be sold', () => {
    const s = togglePick(initialState(NOW), CORE);
    expect(html(<PickStep assets={ASSETS} state={s} onToggle={() => {}} />)).toContain('1 of 30 chosen');
    expect(html(<PickStep assets={[PNFT]} state={initialState(NOW)} onToggle={() => {}} />)).toContain('data-testid="pick-none-eligible"');
    expect(html(<PickStep assets={[]} state={initialState(NOW)} onToggle={() => {}} />)).toContain('data-testid="pick-empty"');
  });
  it('shows the three plain steps with the current one marked', () => {
    const m = html(<StepBar step="price" />);
    expect(m).toContain('aria-current="step"');
    for (const w of ['Choose your card', 'Set your price', 'Choose the time']) expect(m).toContain(w);
    expect(count(m, 'step-bar')).toBe(1);
    expect(m.match(/<li/g)).toHaveLength(3);
  });
});

describe('cards that are already offered', () => {
  const SHOW = '11111111-1111-4111-8111-111111111111';
  const PACK = '22222222-2222-4222-8222-222222222222';
  const inRoom: SellAsset = { ...CORE, mint: 'R'.repeat(44), name: 'In a room', eligible: false, reasons: ['already_listed'], listed: { kind: 'lot', showId: SHOW } };
  const inPack: SellAsset = { ...CORE, mint: 'P'.repeat(44), name: 'In a pack', eligible: false, reasons: ['already_listed'], listed: { kind: 'pack', packId: PACK } };
  const free: SellAsset = { ...CORE, mint: 'F'.repeat(44), name: 'Free again', listed: null };

  it('greys a card in a room out, says "Already listed" and links to that room', () => {
    const m = html(<AssetGrid assets={[inRoom]} picked={new Set()} onToggle={() => {}} />);
    expect(m).toContain('data-listed="lot"');
    expect(m).toContain('sl-card--off');
    expect(m).toContain('Already listed');
    expect(m).toContain(`href="/room/${SHOW}"`);
    expect(m).not.toContain('Cannot be sold:'); // the chip is the whole message, no empty reason list
  });
  it('a card in a pack links to the pack; the pick button is disabled and says Already listed', () => {
    const m = html(<AssetGrid assets={[inPack]} picked={new Set()} onToggle={() => {}} />);
    expect(m).toContain(`href="/packs/${PACK}"`);
    const button = m.match(/<button[^>]*data-testid="pick-card"[^>]*>[^<]*/)![0];
    expect(button).toContain('disabled');
    expect(button).toContain('Already listed');
  });
  it('a card that is free again (sold, unsold or withdrawn) is chosen like any other', () => {
    const m = html(<AssetGrid assets={[free]} picked={new Set()} onToggle={() => {}} />);
    expect(m).not.toContain('data-listed');
    expect(m.match(/<button[^>]*data-testid="pick-card"[^>]*>/)![0]).not.toContain('disabled');
  });
  it('speaks German: "Bereits eingestellt"', () => {
    const m = html(<AssetGrid assets={[inRoom]} picked={new Set()} onToggle={() => {}} />, 'de');
    expect(m).toContain('Bereits eingestellt');
    expect(m).not.toContain('Already listed');
  });
  it('the wizard never adds a listed card, even when the click arrives anyway', () => {
    expect(togglePick(initialState(NOW), { ...inRoom, eligible: true }).lots).toHaveLength(0);
    expect(togglePick(initialState(NOW), inRoom).lots).toHaveLength(0);
    expect(togglePick(initialState(NOW), free).lots).toHaveLength(1);
  });
  it('a chosen card that was listed meanwhile is blocked at the next check', () => {
    const picked = togglePick(initialState(NOW), free);
    const s = applyAssets(picked, [{ ...free, eligible: false, reasons: ['already_listed'], listed: { kind: 'lot', showId: SHOW } }]);
    expect(s.readiness[free.mint]).toEqual({ kind: 'blocked', reasons: ['already_listed'] });
  });
  it('the pick step and the list count only cards that can be sold', () => {
    expect(html(<PickStep assets={[inRoom, inPack]} state={initialState(NOW)} onToggle={() => {}} />)).toContain('data-testid="pick-none-eligible"');
    expect(html(<AssetsView state={{ status: 'ready', assets: [inRoom, free] }} onRetry={() => {}} />)).toContain('2 cards found, 1 eligible to sell.');
  });
});

describe('price and time steps', () => {
  const base = (): WizardState => togglePick(initialState(NOW), CORE);
  const price = (s: WizardState, locale: 'en' | 'de' = 'en') => html(<PriceStep state={s} onChange={() => {}} onChangeLot={() => {}} />, locale);

  it('shows exactly two price fields, "Starting price" and "Minimum price (optional)", with the bid step behind Advanced options', () => {
    const m = price(base());
    const visible = m.slice(0, m.indexOf('data-testid="advanced-price"'));
    expect(count(visible, 'opening-input')).toBe(1);
    expect(count(visible, 'reserve-input')).toBe(1);
    expect(visible).not.toContain('increment-input');
    expect(visible).toContain('Starting price');
    expect(visible).toContain('Minimum price (optional)');
    const advanced = m.slice(m.indexOf('data-testid="advanced-price"'));
    expect(advanced).toContain('Advanced options');
    expect(advanced).toContain('data-testid="increment-input"');
  });

  it('shows inline issues next to the field', () => {
    const m = price(setAllTerms(base(), 'opening', ''));
    expect(m).toContain('data-testid="opening-issue"');
    expect(m).toContain('Enter an amount.');
    expect(m).not.toContain('data-testid="reserve-issue"');
  });
  it('flags a minimum price below the starting price', () => {
    let s = setAllTerms(base(), 'reserve', '5');
    s = setAllTerms(s, 'opening', '10');
    expect(price(s)).toContain('minimum price cannot be lower than the starting price');
  });
  it('offers prices per card only behind Advanced options, and only for several cards', () => {
    expect(count(price(base()), 'lot-terms')).toBe(0);
    const two = togglePick(base(), { ...CORE, mint: 'B'.repeat(44), name: 'Second' });
    const m = price(setTerm(two, two.lots[1].mint, 'opening', '30'));
    expect(count(m, 'lot-terms')).toBe(2);
    expect(m).toContain('Different per card');
    expect(m.indexOf('data-testid="lot-terms"')).toBeGreaterThan(m.indexOf('data-testid="advanced-price"'));
  });
  it('speaks German in the same tone', () => {
    const m = price(base(), 'de');
    for (const w of ['Startpreis', 'Mindestpreis (optional)', 'Erweitert']) expect(m).toContain(w);
  });

  const timeState = (over: Partial<WizardState> = {}): WizardState => ({ ...applyAssets({ ...togglePick(initialState(NOW), CORE), title: 'Saturday night slabs' }, ASSETS), ...over });
  const step = (s: WizardState, extra: Partial<Parameters<typeof TimeStep>[0]> = {}, locale: 'en' | 'de' = 'en') =>
    html(<TimeStep state={s} titleInput="" autoTitle="Card auction" now={NOW} publishing={false} publishError={null} onWhen={() => {}} onStart={() => {}} onTitle={() => {}} onCheck={() => {}} onPublish={() => {}} {...extra} />, locale);

  it('lets the seller choose how long each lot runs: four presets, 45 s selected by default, the anti-sniping cap explained, in both languages', () => {
    const m = step(timeState());
    expect(tag(m, 'lot-duration')).not.toBeNull();
    for (const s of [45, 90, 180, 300]) expect(tag(m, `lot-duration-${s}`)).not.toBeNull();
    expect(tag(m, 'lot-duration-45')).toContain('aria-pressed="true"');
    expect(tag(m, 'lot-duration-90')).toContain('aria-pressed="false"');
    expect(m).toContain('>45 s<');
    expect(m).toContain('>90 s<');
    expect(m).toContain('>3 min<');
    expect(m).toContain('>5 min<');
    expect(m).toContain('Each lot runs 45 seconds.');
    expect(m).toContain('adds time');
    const long = step(timeState({ lotDurationS: 180 }));
    expect(tag(long, 'lot-duration-180')).toContain('aria-pressed="true"');
    expect(long).toContain('Each lot runs 3 minutes.');
    const de = step(timeState({ lotDurationS: 90 }), {}, 'de');
    expect(de).toContain('Wie lange läuft jedes Los?');
    expect(de).toContain('Jedes Los läuft 90 Sekunden.');
    expect(de).toContain('>3 min<');
    expect(de).not.toContain('How long does each lot run?');
  });

  it('a timed auction has its own duration picker and no lot length choice', () => {
    expect(step(timeState({ kind: 'timed', durationS: 86_400 }))).not.toContain('data-testid="lot-duration"');
  });

  it('defaults to Start now with no date field, and shows the date field after choosing Schedule', () => {
    const now = step(timeState());
    expect(tag(now, 'time-now')).toContain('checked');
    expect(now).not.toContain('type="datetime-local"');
    expect(now).toContain('Publish and start now');
    const sched = step(timeState({ when: 'schedule', start: '2026-10-06T20:00' }));
    expect(tag(sched, 'time-schedule')).toContain('checked');
    expect(sched).toContain('type="datetime-local"');
    expect(sched).toContain('value="2026-10-06T20:00"');
    expect(sched).toMatch(/Starts .*20:00.*shown in your time zone/);
    expect(sched).toContain('Publish and schedule');
  });
  it('flags a scheduled start that is too soon', () => {
    expect(step(timeState({ when: 'schedule', start: '2026-10-05T12:01' }))).toContain('data-testid="start-issue"');
  });
  it('keeps the show title behind Advanced options with the generated title as placeholder', () => {
    const m = step(timeState());
    expect(m.indexOf('data-testid="show-title"')).toBeGreaterThan(m.indexOf('data-testid="advanced-time"'));
    expect(m).toContain('placeholder="Card auction"');
  });

  it('keeps Publish disabled until every lot is ready, and says why', () => {
    const unchecked = togglePick({ ...initialState(NOW), title: 'Good title' }, CORE);
    const m = step(unchecked);
    expect(isDisabled(m, 'publish')).toBe(true);
    expect(m).toContain('data-testid="publish-blocked-note"');
    expect(tag(m, 'ready-badge')).toContain('data-state="unchecked"');
    expect(isDisabled(step(markChecking(unchecked)), 'publish')).toBe(true);
    expect(isDisabled(step(markChecking(unchecked)), 'check-ready')).toBe(true);
  });

  it('enables Publish when all are ready and shows the ready badge', () => {
    const m = step(timeState());
    expect(isDisabled(m, 'publish')).toBe(false);
    expect(tag(m, 'ready-badge')).toContain('data-state="ready"');
  });

  it('shows a blocked lot with its reasons and keeps Publish off', () => {
    const s = applyAssets(timeState(), [{ ...CORE, eligible: false, reasons: ['frozen'] }]);
    const m = step(s);
    expect(tag(m, 'ready-badge')).toContain('data-state="blocked"');
    expect(m).toContain('The card is frozen');
    expect(isDisabled(m, 'publish')).toBe(true);
  });

  it('disables Publish while it is being sent, and shows a publish error', () => {
    expect(isDisabled(step(timeState(), { publishing: true }), 'publish')).toBe(true);
    expect(step(timeState(), { publishError: 'Not in wallet' })).toContain('data-testid="publish-error"');
  });

  it('explains the readiness check without a wallet prompt', () => {
    expect(step(timeState())).toContain('You do not sign anything for this check and nothing moves.');
    expect(step(timeState()).includes('wallet prompt')).toBe(false);
  });

  it.each([
    ['en', ['reaches your minimum price', 'Learn more'], ['closes by itself', 'co-sign the delivery', 'stay online', 'strike', 'withdraw a lot only before its first bid', '2.5%']],
    ['de', ['erreicht', 'Mehr erfahren'], ['endet von selbst', 'signieren Sie die Lieferung mit', 'online bleiben', 'Strike', 'nur vor dem ersten Gebot zurückziehen', '2,5 %']],
  ] as const)('keeps the binding rules complete in %s: one short paragraph, the rest under Learn more', (locale, summary, rules) => {
    const m = step(timeState(), {}, locale);
    const copy = m.slice(m.indexOf('data-testid="contract-copy"'), m.indexOf('data-testid="advanced-time"'));
    for (const p of summary) expect(copy, p).toContain(p);
    const more = copy.slice(copy.indexOf('data-testid="learn-more"'));
    for (const p of rules) expect(more, p).toContain(p);
    expect(copy.slice(0, copy.indexOf('data-testid="learn-more"')).match(/<p>/g)).toHaveLength(1);
  });
});

describe('manage page', () => {
  const detail = fixture<{ show: ShowCore; lots: CatalogueLot[] }>('show-detail');
  const snap = fixture<LiveSnapshot>('live-snapshot.open');
  const h: ManageHandlers = { onStart() {}, onEnd() {}, onCancel() {}, onPause() {}, onResume() {}, onWithdraw() {}, onExtend() {}, onSaveReserve() {}, onRecheck() {} };
  const view = (over: { status?: 'scheduled' | 'live' | 'ended'; snapshot?: LiveSnapshot | null; notes?: Record<string, Note>; busy?: boolean } = {}) =>
    html(<ManageView show={detail.show} status={over.status ?? 'scheduled'} lots={mergeLots(detail.lots, over.snapshot ?? null)} notes={over.notes ?? {}} busy={over.busy ?? false} h={h} />);

  it('offers start and cancel on a scheduled show, end on a live show, none on an ended one', () => {
    const scheduled = view({ status: 'scheduled' });
    expect(tag(scheduled, 'start-show')).not.toBeNull();
    expect(tag(scheduled, 'cancel-show')).not.toBeNull();
    expect(tag(scheduled, 'end-show')).toBeNull();
    const live = view({ status: 'live' });
    expect(tag(live, 'end-show')).not.toBeNull();
    expect(tag(live, 'start-show')).toBeNull();
    const ended = view({ status: 'ended' });
    for (const id of ['start-show', 'end-show', 'cancel-show']) expect(tag(ended, id)).toBeNull();
  });

  describe('the pause controls', () => {
    const pausedState = { paused: true, pausedAt: '2026-10-05T10:00:00.000Z', resumesBy: '2026-10-05T10:05:00.000Z', used: 1, max: 2 };
    const idle = { paused: false, pausedAt: null, resumesBy: null, used: 0, max: 2 };
    const withPause = (pause: Parameters<typeof ManageView>[0]['pause'], locale: 'en' | 'de' = 'en') =>
      html(<ManageView show={detail.show} status="live" lots={mergeLots(detail.lots, snap)} notes={{}} busy={false} h={h} pause={pause} />, locale);

    it('offers "Pause room" behind a confirmation on a live room, explains the limits and counts the pauses', () => {
      const m = withPause({ gate: 'ok', state: idle });
      expect(tag(m, 'pause-show')).not.toBeNull();
      expect(tag(m, 'resume-show')).toBeNull();
      expect(m).toContain('At most 2 pauses per show');
      expect(m).toContain('each ends by itself after 5 minutes');
      expect(m).toContain('last 10 seconds');
      expect(m).toContain('Pauses used: 0 of 2');
      expect(m).toContain('data-status="live"'); // the pill still says Live
    });

    it('while paused shows "Resume room", the pill says Paused and the note says when it resumes by itself', () => {
      const m = withPause({ gate: 'paused', state: pausedState });
      expect(tag(m, 'resume-show')).not.toBeNull();
      expect(tag(m, 'pause-show')).toBeNull();
      expect(m).toContain('data-paused="true"');
      expect(m).toContain('>Paused<');
      expect(m).toContain('resumes by itself at');
      expect(m).toContain('Pauses used: 1 of 2');
    });

    it.each([['limit', 'All pauses of this show are used.'], ['no_lot', 'A pause needs a lot on the block.'], ['late', 'Not possible in the last 10 seconds of a lot.']] as const)('shows no button when the gate is %s and says why', (gate, why) => {
      const m = withPause({ gate, state: gate === 'limit' ? { ...idle, used: 2 } : idle });
      expect(tag(m, 'pause-show')).toBeNull();
      expect(tag(m, 'resume-show')).toBeNull();
      expect(m).toContain(why);
    });

    it('draws nothing for a timed or ended show, and speaks German too', () => {
      expect(html(<ManageView show={detail.show} status="ended" lots={[]} notes={{}} busy={false} h={h} pause={{ gate: 'unavailable', state: idle }} />)).not.toContain('pause-note');
      const de = withPause({ gate: 'ok', state: idle }, 'de');
      expect(de).toContain('Raum pausieren');
      expect(de).toContain('Höchstens 2 Pausen pro Show');
      expect(withPause({ gate: 'paused', state: pausedState }, 'de')).toContain('Raum fortsetzen');
      expect(de).not.toContain('Pause room');
    });
  });

  it('allows an edit of the reserve and a withdraw while a lot waits', () => {
    const m = view();
    expect(count(m, 'manage-reserve-input')).toBe(detail.lots.length);
    expect(tag(m, 'withdraw-lot')).not.toBeNull();
    expect(isDisabled(m, 'withdraw-lot')).toBe(false);
  });

  it('disables withdraw and extend and explains why once a lot has a bid', () => {
    const lot = snap.lots[0];
    const withBid: LiveSnapshot = { ...snap, lots: snap.lots.map((l) => (l.id === lot.id ? { ...l, state: 'open', bidCount: 2, highBid: '60000000' } : l)) };
    const m = view({ status: 'live', snapshot: withBid });
    expect(m).toContain('data-testid="withdraw-locked"');
    expect(m).toContain('can no longer be withdrawn or extended');
    expect(m).not.toContain('data-testid="extend-lot"');
    const buttons = m.match(/<button[^>]*data-testid="withdraw-lot"[^>]*>/g)!;
    expect(buttons.some((b) => b.includes('disabled'))).toBe(true);
  });

  it('does not offer a reserve edit for a lot that is already open', () => {
    const open: LiveSnapshot = { ...snap, lots: detail.lots.map((l) => ({ id: l.id, lotNumber: l.lotNumber, state: 'open' as const, highBid: null, highBidder: null, bidCount: 0, closesAt: null })) };
    const m = view({ status: 'live', snapshot: open });
    expect(count(m, 'manage-reserve-input')).toBe(0);
    expect(count(m, 'extend-lot')).toBe(detail.lots.length); // no bid yet, so extending is still allowed
  });

  it("shows the server's wrong_state answer next to the lot", () => {
    const id = detail.lots[0].id;
    const m = view({ notes: { [id]: { kind: 'error', text: 'That is not possible in the current state. The lot already has a bid.' } } });
    expect(tag(m, 'lot-note')).toContain('data-kind="error"');
    expect(m).toContain('The lot already has a bid.');
  });

  it('shows a show-level answer, and states the rules', () => {
    const m = view({ notes: { show: { kind: 'error', text: 'Some lots are not ready yet. Check the cards again.' } } });
    expect(tag(m, 'show-note')).not.toBeNull();
    expect(m).toContain('data-testid="manage-rules"');
    expect(m).toContain('co-sign the delivery');
  });

  it('offers the readiness re-check for a lot whose card is not ready', () => {
    const pending = { ...detail.lots[0], consignStatus: 'pending' as const };
    const m = html(<ManageView show={detail.show} status="scheduled" lots={mergeLots([pending], null)} notes={{}} busy={false} h={h} />);
    expect(tag(m, 'recheck-lot')).not.toBeNull();
  });
});

describe('schedule', () => {
  const NOW_MS = Date.parse('2026-10-05T12:00:00Z');
  const base = fixture<{ shows: ShowSummary[] }>('show-list').shows[0];
  const show = (over: Partial<ShowSummary>): ShowSummary => ({ ...base, ...over });
  const render = (state: Parameters<typeof ScheduleView>[0]['state']) => html(<ScheduleView state={state} nowMs={NOW_MS} origin="https://hp.test" />);

  it('shows loading and error states', () => {
    expect(render({ status: 'loading' })).toContain('rooms-loading');
    expect(render({ status: 'error' })).toContain('rooms-error');
  });

  it('shows an empty state with a way to sell when nothing is on', () => {
    const m = render({ status: 'ready', live: [], scheduled: [], ended: [] });
    expect(m).toContain('data-testid="rooms-empty"');
    expect(m).toContain('href="/sell"');
  });

  it('lists live, upcoming with a countdown and a calendar link, and ended rows', () => {
    const m = render({
      status: 'ready',
      live: [show({ id: 'L', status: 'live', title: 'Live one' })],
      scheduled: [show({ id: 'S', status: 'scheduled', title: 'Soon', scheduledAt: '2026-10-05T13:30:45Z', isHouse: false })],
      ended: [show({ id: 'E', status: 'ended', title: 'Done', startedAt: '2026-10-01T10:00:00Z', soldCount: 2, hammerTotal: '240000000' })],
    });
    expect(tag(m, 'room-live')).toContain('href="/room/L"');
    expect(m).toMatch(/data-testid="countdown"[^>]*>Starts in 01:30:45</);
    const cal = tag(m, 'add-to-calendar')!;
    expect(cal).toContain('href="data:text/calendar;charset=utf-8,BEGIN%3AVCALENDAR');
    expect(cal).toContain('download="hammerprice-');
    expect(decodeURIComponent(cal)).toContain('DTSTART:20261005T133045Z');
    expect(m).toContain('240.00 USDC');
  });

  it('removes a past-dated scheduled row and never shows a total for a show where nothing sold', () => {
    const m = render({
      status: 'ready',
      live: [],
      scheduled: [show({ id: 'OLD', status: 'scheduled', title: 'Sat Sep 5 room', scheduledAt: '2026-09-05T17:00:00Z' })],
      ended: [show({ id: 'E', status: 'ended', title: 'Empty', soldCount: 0, hammerTotal: '1091000000' })],
    });
    expect(m).not.toContain('Sat Sep 5 room');
    expect(m).not.toContain('data-testid="rooms-scheduled"');
    expect(m).not.toContain('1,091');
    expect(m).toContain('none sold');
  });

  it('says "starting now" when the start passed by a minute and labels demo rooms honestly', () => {
    const m = render({ status: 'ready', live: [], ended: [], scheduled: [show({ scheduledAt: '2026-10-05T11:59:00Z', isHouse: true, cluster: 'devnet' })] });
    expect(m).toContain('Starting now');
    expect(m).toContain('data-testid="badge-house"');
    expect(m).toContain('Devnet');
    expect(m).not.toMatch(/test money|Testgeld/);
  });

  it('puts the demo rooms (tutorial) first, with their badge and one plain sentence, and real rooms in their own section', () => {
    const m = render({
      status: 'ready',
      live: [show({ id: 'S1', status: 'live', title: 'Seller room', isHouse: false, cluster: 'devnet' }), show({ id: 'H1', status: 'live', title: 'House show #1', isHouse: true })],
      scheduled: [],
      ended: [],
    });
    expect(m.indexOf('data-testid="rooms-demo"')).toBeGreaterThan(-1);
    expect(m.indexOf('data-testid="rooms-demo"')).toBeLessThan(m.indexOf('data-testid="rooms-sellers"'));
    const demo = m.slice(m.indexOf('data-testid="rooms-demo"'), m.indexOf('data-testid="rooms-sellers"'));
    const sellers = m.slice(m.indexOf('data-testid="rooms-sellers"'));
    expect(demo).toContain('House show #1');
    expect(demo).not.toContain('Seller room');
    expect(demo).toContain('data-testid="badge-demo"');
    expect(demo).toContain('Tutorial: practise bidding here.');
    expect(demo).toContain('The labelled bots never outbid a person.');
    expect(demo).toContain('Bid against the labelled bots.'); // the intro under it
    expect(demo).not.toMatch(/test USDC|replica/i); // the card's own Devnet badge stays
    expect(sellers).toContain('Real rooms');
    expect(sellers).toContain('Seller room');
    expect(sellers).not.toContain('House show #1');
    expect(sellers).not.toContain('data-testid="badge-demo"'); // a seller's room is never labelled demo
    expect(sellers).not.toContain('data-testid="badge-house"');
    expect(sellers).not.toContain('data-testid="rooms-empty"');
  });

  it('never lists a house show among the seller rooms, whichever list it arrived in', () => {
    const m = render({
      status: 'ready',
      live: [],
      scheduled: [show({ id: 'H2', status: 'scheduled', title: 'House next', isHouse: true, scheduledAt: '2026-10-05T12:05:00Z' })],
      ended: [show({ id: 'H3', status: 'ended', title: 'House done', isHouse: true, startedAt: '2026-10-05T11:00:00Z' })],
    });
    const sellers = m.slice(m.indexOf('data-testid="rooms-sellers"'));
    expect(sellers).not.toContain('House next');
    expect(sellers).not.toContain('House done');
    expect(sellers).toContain('data-testid="rooms-empty"');
  });

  it('with no seller rooms it invites to create one (link to the sell wizard) and says how a second wallet lets a judge try both sides', () => {
    const m = render({ status: 'ready', live: [show({ id: 'H1', status: 'live', isHouse: true })], scheduled: [], ended: [] });
    const empty = m.slice(m.indexOf('data-testid="rooms-empty"'));
    expect(empty).toContain('href="/sell"');
    expect(empty).toContain('No real rooms right now');
    expect(empty).toContain('List your card');
    expect(empty).toContain('href="/about#how"');
    expect(empty).toContain('How selling works');
    expect(empty).toContain('second wallet');
    expect(empty).toContain('The higher bid wins');
    const de = html(<ScheduleView state={{ status: 'ready', live: [], scheduled: [], ended: [] }} nowMs={NOW_MS} origin="" />, 'de');
    expect(de).toContain('Echte Räume');
    expect(de).toContain('Gerade keine echten Räume');
    expect(de).toContain('zweite Wallet');
    expect(de).toContain('Demo-Räume (Tutorial)');
    expect(de).toContain('href="/sell"');
  });

  it('when the demo room is between shows it still links to /room/house', () => {
    const m = render({ status: 'ready', live: [], scheduled: [], ended: [] });
    expect(m.slice(m.indexOf('data-testid="rooms-demo"'), m.indexOf('data-testid="rooms-sellers"'))).toContain('href="/room/house"');
  });

  it('keeps seller timed rooms out of the demo block and house timed auctions in it with the same DEMO badge', () => {
    const m = render({
      status: 'ready',
      live: [show({ id: 'HT', status: 'live', title: 'Timed house lot #1', isHouse: true, kind: 'timed', closesAt: '2026-10-05T18:00:00Z' })],
      scheduled: [],
      ended: [],
    });
    const demo = m.slice(m.indexOf('data-testid="rooms-demo"'), m.indexOf('data-testid="rooms-sellers"'));
    expect(demo).toContain('Timed house lot #1');
    expect(demo).toContain('data-testid="badge-demo"');
    expect(demo).toContain('data-testid="badge-timed"');
  });

  it('marks the live demo and the timed demo separately, each with its tutorial line, and offers to list a card in the demo footer', () => {
    const m = render({
      status: 'ready',
      live: [
        show({ id: 'H1', status: 'live', title: 'House show #4', isHouse: true }),
        show({ id: 'HT', status: 'live', title: 'Timed house lot #2', isHouse: true, kind: 'timed', closesAt: '2026-10-05T18:00:00Z' }),
      ],
      scheduled: [],
      ended: [],
    });
    const demo = m.slice(m.indexOf('data-testid="rooms-demo"'), m.indexOf('data-testid="rooms-sellers"'));
    expect(demo).toContain('Demo rooms (tutorial)');
    expect(demo).toContain('Tutorial: how a live auction room works');
    expect(demo).toContain('Tutorial: how a timed auction works');
    expect(demo.match(/data-testid="tutorial-line"/g)).toHaveLength(2);
    expect(demo.match(/data-testid="badge-demo"/g)!.length).toBeGreaterThanOrEqual(2);
    const footer = demo.slice(demo.indexOf('data-testid="demo-footer"'));
    expect(footer).toContain('Done with the tutorial? Real rooms are below, or list your own card');
    expect(footer).toContain('href="/sell"');
    expect(footer).toContain('List your card');
    // the real section has no tutorial line and, with no seller room, its own empty state
    const sellers = m.slice(m.indexOf('data-testid="rooms-sellers"'));
    expect(sellers).not.toContain('data-testid="tutorial-line"');
    expect(sellers).toContain('data-testid="rooms-empty"');
  });

  it('shows real rooms, not the empty state, when a seller room exists', () => {
    const m = render({ status: 'ready', live: [show({ id: 'S1', status: 'live', title: 'Seller room', isHouse: false })], scheduled: [], ended: [] });
    const sellers = m.slice(m.indexOf('data-testid="rooms-sellers"'));
    expect(sellers).toContain('Seller room');
    expect(sellers).not.toContain('No real rooms right now');
    expect(sellers).not.toContain('data-testid="rooms-filter-empty"');
  });

  it('renders in German', () => {
    const m = html(<ScheduleView state={{ status: 'ready', live: [], ended: [], scheduled: [show({ scheduledAt: '2026-10-06T18:00:00Z' })] }} nowMs={NOW_MS} origin="" />, 'de');
    expect(m).toContain('Demnächst');
    expect(m).toContain('Zum Kalender hinzufügen');
    expect(m).toContain('Beginnt in');
  });
});

describe('wizard copy and step indicator', () => {
  const one = togglePick(initialState(NOW), CORE);
  it('says the 2.5% fee on the price step, in English and German (Sie-form)', () => {
    const en = html(<PriceStep state={one} onChange={() => {}} onChangeLot={() => {}} />);
    expect(en).toContain('data-testid="price-fee"');
    expect(en).toContain('2.5% of the final price');
    const de = html(<PriceStep state={one} onChange={() => {}} onChangeLot={() => {}} />, 'de');
    expect(de).toContain('2,5 %');
    expect(de).toContain('Ihrer Auszahlung');
  });
  it('the step indicator names the step for screen readers and marks finished steps with a check', () => {
    const m = html(<StepBar step="price" />);
    expect(m).toContain('(Step 2 of 3)');
    expect(m).toContain('✓');
  });
  it('the empty pick step is a titled empty state', () => {
    const m = html(<PickStep assets={[]} state={initialState(NOW)} onToggle={() => {}} />);
    expect(m).toContain('No cards in this wallet yet');
  });
});
