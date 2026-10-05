import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChatError, errorKey, fetchPublic, hasSession, moderate, newNonce, POLL_CLOSED_MS, POLL_MAX_BACKOFF_MS, POLL_OFF_MS, POLL_OPEN_MS, pollDelayMs, readBlocked, sendMessage, writeBlocked,
} from '../chatClient';

afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stubFetch = (res: Response | Error) => vi.stubGlobal('fetch', vi.fn(async () => { if (res instanceof Error) throw res; return res; }));

describe('pollDelayMs', () => {
  it('open is fast, closed slow, a disabled chat rare', () => {
    expect(pollDelayMs({ open: true, enabled: true, errorStreak: 0 })).toBe(POLL_OPEN_MS);
    expect(pollDelayMs({ open: false, enabled: true, errorStreak: 0 })).toBe(POLL_CLOSED_MS);
    expect(pollDelayMs({ open: true, enabled: false, errorStreak: 0 })).toBe(POLL_OFF_MS);
  });
  it('doubles per error up to the cap, jitters by 10 percent', () => {
    expect(pollDelayMs({ open: true, enabled: true, errorStreak: 1 })).toBe(POLL_OPEN_MS * 2);
    expect(pollDelayMs({ open: true, enabled: true, errorStreak: 20 })).toBe(POLL_MAX_BACKOFF_MS);
    expect(pollDelayMs({ open: true, enabled: true, errorStreak: 0, random: 0 })).toBe(Math.round(POLL_OPEN_MS * 0.9));
    expect(pollDelayMs({ open: true, enabled: true, errorStreak: 0, random: 1 })).toBe(Math.round(POLL_OPEN_MS * 1.1));
  });
});

describe('calls', () => {
  it('a valid public list is parsed', async () => {
    stubFetch(reply(200, { enabled: true, messages: [], lastSeq: 0 }));
    await expect(fetchPublic('s')).resolves.toEqual({ enabled: true, messages: [], lastSeq: 0 });
  });
  it('a refused message exposes its rule as reasonKey', async () => {
    stubFetch(reply(400, { ok: false, code: 'validation', reason: 'link' }));
    const e = await sendMessage('s', { body: 'x', clientNonce: newNonce() }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChatError);
    expect(e).toMatchObject({ code: 'validation', status: 400, reasonKey: 'link' });
    expect(errorKey(e)).toBe('reason.link');
  });
  it('other errors map to their own text', async () => {
    stubFetch(reply(403, { ok: false, code: 'muted', reason: 'The room operator has muted you for now' }));
    expect(errorKey(await moderate('s', { action: 'unsilence', paddle: 1 }).catch((x: unknown) => x))).toBe('muted');
    stubFetch(new TypeError('offline'));
    const net = await fetchPublic('s').catch((x: unknown) => x);
    expect(net).toMatchObject({ code: 'network' });
    expect(errorKey(net)).toBe('network');
    stubFetch(reply(200, { nope: true }));
    expect(await fetchPublic('s').catch((x: unknown) => x)).toMatchObject({ code: 'shape' });
    stubFetch(reply(500, 'oops'));
    expect(errorKey(await fetchPublic('s').catch((x: unknown) => x))).toBe('generic');
    expect(errorKey(new Error('x'))).toBe('generic');
  });
  it('a validation error that is not one of the chat rules is the generic text', () => {
    expect(errorKey(new ChatError('validation', 400, 'body: too short', 'body: too short'))).toBe('generic');
  });
  it('hasSession: 200 yes, 204 and 401 and a network error no', async () => {
    stubFetch(new Response('{}', { status: 200 }));
    expect(await hasSession('s')).toBe(true);
    stubFetch(new Response(null, { status: 204 }));
    expect(await hasSession('s')).toBe(false);
    stubFetch(new Response('{}', { status: 401 }));
    expect(await hasSession('s')).toBe(false);
    stubFetch(new TypeError('offline'));
    expect(await hasSession('s')).toBe(false);
  });
});

describe('the local block list', () => {
  it('is kept per show, in memory, and ignores junk', () => {
    expect(readBlocked('a')).toEqual([]);
    writeBlocked('a', [3, 7, -1, 2.5, 0]);
    expect(readBlocked('a')).toEqual([3, 7]);
    expect(readBlocked('b')).toEqual([]);
    writeBlocked('a', []);
    expect(readBlocked('a')).toEqual([]);
  });
});

describe('newNonce', () => {
  it('is a v4 uuid, with and without crypto.randomUUID', () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(newNonce()).toMatch(re);
    vi.stubGlobal('crypto', {});
    expect(newNonce()).toMatch(re);
  });
});
