/** The local conversation history: per wallet, versioned, capped, validated, and never throwing (private mode). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CHARS, MAX_MESSAGES, capHistory, loadHistory, saveHistory, type Msg } from '../history';

const store = new Map<string, string>();
const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const g = globalThis as { window?: unknown };
beforeEach(() => { store.clear(); g.window = { localStorage: fake }; });
afterEach(() => { delete g.window; });

const id = '11111111-1111-4111-8111-111111111111';
const ai = (text: string): Msg => ({ role: 'ai', text, label: 'ai', cards: [] });
const user = (text: string): Msg => ({ role: 'user', text });
const bid: Msg = { role: 'ai', text: 'Here is a bid proposal.', label: 'ai', cards: [{ type: 'bid', lotId: id, showId: id, lotNumber: 3, name: 'Charizard', currentBidUsdc: null, amountUsdc: '35000000', limitUsdc: '50000000', incrementUsdc: '5000000' }] };

const HISTORY_PREFIX = 'hp:ai-agent:v1:';

describe('local history', () => {
  it('round-trips messages and cards, under a namespaced, versioned key per wallet', () => {
    saveHistory('walletA', [user('hi'), bid]);
    expect([...store.keys()]).toEqual([`${HISTORY_PREFIX}walletA`]);
    expect(HISTORY_PREFIX).toMatch(/:v1:$/);
    expect(loadHistory('walletA')).toEqual([user('hi'), bid]);
  });
  it('another wallet never sees it', () => {
    saveHistory('walletA', [user('secret')]);
    expect(loadHistory('walletB')).toEqual([]);
  });
  it('saving an empty conversation (Reset chat) removes the entry, and only that wallet\'s', () => {
    saveHistory('walletA', [user('a')]); saveHistory('walletB', [user('b')]);
    saveHistory('walletA', []);
    expect(loadHistory('walletA')).toEqual([]);
    expect(loadHistory('walletB')).toEqual([user('b')]);
  });
  it('keeps the newest 200 messages and at most about 300 KB, oldest first out', () => {
    const many = Array.from({ length: 260 }, (_, i) => user(`m${i}`));
    const kept = capHistory(many);
    expect(kept).toHaveLength(MAX_MESSAGES);
    expect(kept[0]).toEqual(user('m60'));
    const big = Array.from({ length: 150 }, (_, i) => ai(`${i}:`.padEnd(1900, 'x')));
    const small = capHistory(big);
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(MAX_CHARS);
    expect(small[small.length - 1]).toEqual(big[149]);
  });
  it('drops entries of another version, broken JSON and messages that do not match the contract', () => {
    store.set(`${HISTORY_PREFIX}w`, JSON.stringify({ v: 2, msgs: [user('x')] }));
    expect(loadHistory('w')).toEqual([]);
    store.set(`${HISTORY_PREFIX}w`, '{not json');
    expect(loadHistory('w')).toEqual([]);
    store.set(`${HISTORY_PREFIX}w`, JSON.stringify({ v: 1, msgs: [user('ok'), { role: 'ai', text: 'x', label: 'ai', cards: [{ type: 'evil' }] }, { role: 'system', text: 'y' }, 7] }));
    expect(loadHistory('w')).toEqual([user('ok')]);
  });
  it('never throws when storage is blocked (private mode) or full', () => {
    g.window = { get localStorage(): never { throw new Error('blocked'); } };
    expect(() => saveHistory('w', [user('x')])).not.toThrow();
    expect(loadHistory('w')).toEqual([]);
    g.window = { localStorage: { ...fake, setItem: () => { throw new Error('quota'); } } };
    expect(() => saveHistory('w', [user('x')])).not.toThrow();
    delete g.window;
    expect(loadHistory('w')).toEqual([]);
  });
});
