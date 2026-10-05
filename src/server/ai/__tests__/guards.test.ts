/**
 * Static guards for the AI surface (no database): the rate settings and their safe defaults, every AI route asks for the wallet session before
 * anything that costs, the agent and the assistant import nothing that can bid or move funds, no component writes HTML from a string, and the
 * model key never reaches client code.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { aiConfig, aiRateLimits } from '../config';
import { AiError } from '../errors';
import { TOOLS } from '../agent';

const root = join(__dirname, '..', '..', '..', '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(f, out); } else if (/\.(ts|tsx)$/.test(n)) out.push(f);
  }
  return out;
}

describe('rate settings', () => {
  it('defaults: 6 a minute, 60 an hour, 300 a day per wallet; 20, 100 and 100 per address; 8 calls in flight; breaker at 5 failures in 120 s', () => {
    expect(aiRateLimits({})).toEqual({ wallet: { min: 6, hour: 60, day: 300 }, ip: { min: 20, hour: 100, day: 100 } });
    expect(aiConfig({})).toMatchObject({ maxConcurrent: 8, breakerErrors: 5, breakerWindowS: 120 });
  });
  it('the env overrides them; zero, negative, decimal, empty and text values are the default (never "no limit"), and a huge value is capped', () => {
    expect(aiRateLimits({ AI_RATE_PER_MIN: '3', AI_RATE_PER_HOUR: '30', AI_RATE_PER_DAY: '90', AI_RATE_IP_PER_MIN: '9' })).toEqual({ wallet: { min: 3, hour: 30, day: 90 }, ip: { min: 9, hour: 100, day: 100 } });
    for (const bad of ['0', '-5', '2.5', '', ' ', 'abc', 'Infinity', 'NaN']) expect(aiRateLimits({ AI_RATE_PER_MIN: bad, AI_RATE_PER_DAY: bad }).wallet, bad).toMatchObject({ min: 6, day: 300 });
    expect(aiRateLimits({ AI_RATE_PER_DAY: '99999999999' }).wallet.day).toBe(100_000);
    expect(aiConfig({ AI_MAX_CONCURRENT: '0', AI_BREAKER_ERRORS: 'x' })).toMatchObject({ maxConcurrent: 8, breakerErrors: 5 });
  });
});

describe('every AI route needs the wallet session before anything that costs', () => {
  const routes = walk(join(root, 'src/app/api/ai')).filter((f) => f.endsWith('route.ts'));
  it('finds the routes (agent, ask, listing, credits, quote, pay, purchases)', () => {
    expect(routes.map((f) => relative(join(root, 'src/app/api/ai'), f)).sort()).toEqual(['agent/route.ts', 'ask/route.ts', 'credits/pay/route.ts', 'credits/purchases/[id]/route.ts', 'credits/quote/route.ts', 'credits/route.ts', 'listing/route.ts']);
  });
  for (const f of routes) {
    it(`${relative(root, f)}: feature gate, then session, then the rest`, () => {
      const s = readFileSync(f, 'utf8');
      const session = s.search(/requireSession(Profile)?\(/);
      expect(session, 'no session check').toBeGreaterThan(-1);
      expect(s.indexOf('requireAi()')).toBeGreaterThan(-1);
      expect(s.indexOf('requireAi()')).toBeLessThan(session);
      const costly = [/assertAiRate\(/, /assertRate\(/, /readBody\(/, /readBigBody\(/, /runAgent\(/, /\bask\(/, /createListing\(/, /getCreditService\(\)/, /await import\('@\/db'\)/]
        .map((re) => s.search(re)).filter((i) => i >= 0);
      expect(Math.min(...costly), 'something runs before the session check').toBeGreaterThan(session);
    });
  }
  it('the three model routes share the per-wallet and per-address limit (minute, hour, day)', () => {
    for (const r of ['agent', 'ask', 'listing']) expect(src(`src/app/api/ai/${r}/route.ts`)).toContain('assertAiRate(req, session.wallet)');
  });
});

describe('no tool can place a bid or move funds', () => {
  it('the closed tool list is exactly search, draft proposal, bid proposal', () => {
    expect([...TOOLS]).toEqual(['search_lots', 'draft_listing', 'prepare_bid']);
  });
  const FORBIDDEN_IMPORT = /from '(?:@\/server\/(?:bids|settlement|chain|packs|credits|auctions|wallet|payments|telegram)|@\/lib\/chain|@solana|\.\.\/(?:bids|settlement|credits|packs))[^']*'/;
  for (const f of ['agent', 'ask', 'classify', 'filter', 'keyword', 'faq', 'prompt', 'template', 'gemini']) {
    it(`server/ai/${f}.ts imports nothing that bids, pays, signs or books credits`, () => {
      expect(src(`src/server/ai/${f}.ts`)).not.toMatch(FORBIDDEN_IMPORT);
    });
  }
  it('the agent only reads and proposes: no insert, update or delete, no fetch, no chain call', () => {
    const a = src('src/server/ai/agent.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(a).not.toMatch(/\.(insert|update|delete)\(|\bfetch\(|sendTransaction|signTransaction/);
    // The one transaction is the budget reservation (a row in ai_usage, a cost counter), made through budget.ts.
    expect(a).toContain('lockBudget');
  });
  it('listing.ts (the only AI file that books credits) never bids and never touches a wallet or the chain', () => {
    expect(src('src/server/ai/listing.ts')).not.toMatch(/@\/server\/(?:bids|settlement|chain|packs|auctions)|@\/lib\/chain|@solana|\.insert\(\s*(?:bids|lots|shows)\b/);
  });
});

describe('model output is text in React, never markup', () => {
  it('no component or page writes HTML from a string (only the JSON-LD script, whose escaping has its own test)', () => {
    const hits = walk(join(root, 'src')).filter((f) => /dangerouslySetInnerHTML|\.innerHTML\b|insertAdjacentHTML|document\.write\(|\beval\(|new Function\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
    expect(hits).toEqual(['src/components/landing/JsonLd.tsx']);
  });
  it('no chat bubble or card renders a link from model or user text: every href in the AI components is built here from a locale and an id', () => {
    for (const f of walk(join(root, 'src/components/ai')).concat(join(root, 'src/components/room/slots/Assistant.tsx'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/href=\{?([^}\s>]+)/g)) {
        expect(m[1], `${relative(root, f)}: ${m[1]}`).toMatch(/^(?:`\/\$\{lang\}\/|"\/|bought\.url|`\/\$\{)/);
      }
    }
  });
});

describe('the model key stays on the server', () => {
  it('no client component or hook reads or names a model credential', () => {
    const bad = walk(join(root, 'src/components')).concat(walk(join(root, 'src/lib/i18n'))).filter((f) => /GEMINI_API_KEY|GCP_SERVICE_ACCOUNT_JSON|x-goog-api-key|NEXT_PUBLIC_[A-Z_]*(?:GEMINI|GOOGLE_API|AI_KEY)/i.test(readFileSync(f, 'utf8')));
    expect(bad.map((f) => relative(root, f))).toEqual([]);
  });
  it('the only server/ai file a client component imports is keyword.ts, and it reads no environment', () => {
    const imports = new Set<string>();
    for (const f of walk(join(root, 'src/components'))) for (const m of readFileSync(f, 'utf8').matchAll(/from '@\/server\/ai\/([\w-]+)'/g)) imports.add(m[1]!);
    expect([...imports].filter((i) => !['keyword'].includes(i))).toEqual([]);
    expect(src('src/server/ai/keyword.ts')).not.toMatch(/process\.env|\.\/config|\.\/gemini/);
  });
  it('NEXT_PUBLIC_ never carries the key: .env.example names GEMINI_API_KEY without the prefix', () => {
    expect(src('.env.example')).not.toMatch(/NEXT_PUBLIC_GEMINI|NEXT_PUBLIC_GOOGLE_API/);
  });
});

describe('error messages carry no provider internals', () => {
  it('an AiError is a kind and a status, whatever Google said', () => {
    expect(new AiError('http', 503).message).toBe('ai http 503');
    expect(new AiError('blocked').message).toBe('ai blocked');
    expect(src('src/server/ai/gemini.ts')).not.toMatch(/res\.text\(\)|\.error\.message/);
  });
  it('the AI code logs only a kind and a status (never a message, a prompt, an answer or a key)', () => {
    for (const f of ['agent', 'ask', 'classify', 'listing', 'gemini', 'google-auth', 'budget']) {
      for (const m of src(`src/server/ai/${f}.ts`).matchAll(/console\.(?:log|info|warn|error)\(([^\n]*)/g)) {
        expect(m[1], `${f}.ts logs ${m[1]}`).not.toMatch(/question|message|\bparts\b|prompt|req\.|body|apiKey|serviceAccount|e\.message|String\(e\)|\be\)/);
      }
    }
  });
});
