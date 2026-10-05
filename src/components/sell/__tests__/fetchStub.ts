import { vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

export const fixture = <T = unknown>(name: string): T =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../../../contracts/fixtures', `${name}.json`), 'utf8'));

export interface Call { method: string; url: string; body: unknown }
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/**
 * Replace global fetch. `routes` maps "METHOD /path" (query ignored unless listed with it) to a reply or a function
 * returning one; an unmatched request fails the test loudly. Returns the recorded calls.
 */
export function stubFetch(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const url = String(input);
    const call: Call = { method, url, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = Object.keys(routes).find((k) => k === `${method} ${url}` || k === `${method} ${url.split('?')[0]}`);
    if (!key) throw new Error(`unexpected request ${method} ${url}`);
    const r = typeof routes[key] === 'function' ? (routes[key] as (c: Call) => Reply)(call) : (routes[key] as Reply);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: r.headers });
  }));
  return calls;
}
export const unstub = () => vi.unstubAllGlobals();
