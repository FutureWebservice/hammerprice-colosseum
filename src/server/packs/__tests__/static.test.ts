/**
 * Properties of the pack code that no behaviour test can show: the routes in the contract exist and are all behind the feature gate; nothing
 * about the cluster is spelled in the code of this package (everything comes from the one switch, lib/chain/config.ts); no client file reaches
 * a server key; no route reaches a key loader or an RPC client directly.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTES } from '@/contracts';

const SRC = path.resolve(__dirname, '../../..');
const walk = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)])) : []);
const code = (f: string) => fs.readFileSync(f, 'utf8');

const apiRoot = path.join(SRC, 'app/api');
const fileFor = (p: string) => path.join(apiRoot, ...p.replace(/^\/api\//, '').split('/').map((s) => (s.startsWith(':') ? `[${s.slice(1)}]` : s)), 'route.ts');
const packRoutes = Object.entries(ROUTES).filter(([, r]) => r.agent === 'PACKS');

describe('the pack routes of the contract', () => {
  it('there are twelve; each route file exports exactly the methods the contract gives its path, every one wrapped in packRoute (the feature gate)', () => {
    expect(packRoutes).toHaveLength(12);
    const byFile = new Map<string, { names: string[]; methods: string[] }>();
    for (const [name, r] of packRoutes) {
      const f = fileFor(r.path);
      expect(fs.existsSync(f), `${name}: ${f}`).toBe(true);
      const e = byFile.get(f) ?? { names: [], methods: [] };
      e.names.push(name); e.methods.push(r.method);
      byFile.set(f, e);
    }
    for (const [f, { names, methods }] of byFile) {
      const src = code(f);
      expect([...src.matchAll(/export const (GET|POST|PATCH|DELETE)\b/g)].map((m) => m[1]).sort(), names.join(',')).toEqual([...methods].sort());
      for (const m of methods) expect(src, `${names.join(',')} ${m}`).toMatch(new RegExp(`export const ${m} = packRoute\\(`));
    }
  });
  it('cache modes come from the contract; routes that need a session never cache', () => {
    for (const [name, r] of packRoutes) {
      const src = code(fileFor(r.path));
      if (r.cache === 'none') expect(src, name).not.toMatch(/cdnS/);
      else expect(src, name).toContain(`ROUTES.${name}.cache`);
      if (r.auth === 'session') expect(r.cache, name).toBe('none');
    }
  });
  it('every route lists feature_off', () => {
    for (const [name, r] of packRoutes) expect(r.errors, name).toContain('feature_off');
  });
  it('no route file reaches a key loader, the RPC client or a balance read; only the service layer does', () => {
    for (const f of walk(path.join(apiRoot, 'packs'))) expect(code(f), f).not.toMatch(/lib\/chain\/(keys|rpc|funds|port)|lib\/vrf\/key|secretKey|SECRET_KEY|getBalance|lamports/i);
  });
});

describe('the cluster is never spelled in the code of this package', () => {
  // house.ts is the one devnet module (the platform's own test pack exists on devnet only, by design).
  const files = [
    ...walk(path.join(SRC, 'server/packs')).filter((f) => !f.endsWith('house.ts')),
    ...walk(path.join(SRC, 'lib/packs')), ...walk(path.join(SRC, 'components/packs')), ...walk(path.join(SRC, 'app/api/packs')),
    ...walk(path.join(SRC, 'app/[locale]/packs')), ...walk(path.join(SRC, 'app/[locale]/verify/packs')), path.join(SRC, 'lib/chain/pack-tx.ts'),
  ].filter((f) => /\.(ts|tsx)$/.test(f));
  it('has files to look at', () => expect(files.length).toBeGreaterThan(10));
  it('no literal devnet or mainnet network name, mint address, RPC host or explorer cluster query', () => {
    for (const f of files) {
      const src = code(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/['"`](devnet|mainnet-beta|mainnet)['"`]/);
      expect(src, f).not.toMatch(/api\.(devnet|mainnet-beta)\.solana\.com|cluster=devnet|EPjFWdd5|4zMMC9sr|explorer\.solana\.com/);
    }
  });
});

describe('client files', () => {
  const client = [...walk(path.join(SRC, 'components/packs')), ...walk(path.join(SRC, 'lib/packs')), ...walk(path.join(SRC, 'app/[locale]/packs')), ...walk(path.join(SRC, 'app/[locale]/verify/packs'))].filter((f) => /\.(ts|tsx)$/.test(f));
  it('never import a server module, the database, a key or the VRF secret key', () => {
    for (const f of client) {
      expect(code(f), f).not.toMatch(/from '@\/(server|db)\b|lib\/chain\/keys|lib\/vrf\/key|@\/lib\/chain\/(rpc|port|funds)'|SECRET_KEY|process\.env\.(?!NEXT_PUBLIC)/);
    }
  });
});

describe('house style', () => {
  it('no em dash in any file of the package (code, comments, copy)', () => {
    const all = [
      ...walk(path.join(SRC, 'server/packs')), ...walk(path.join(SRC, 'lib/packs')), ...walk(path.join(SRC, 'components/packs')), ...walk(path.join(SRC, 'app/api/packs')),
      ...walk(path.join(SRC, 'app/[locale]/packs')), ...walk(path.join(SRC, 'app/[locale]/verify/packs')), path.join(SRC, 'lib/chain/pack-tx.ts'),
      path.join(SRC, 'locales/de/packs.json'), path.join(SRC, 'locales/en/packs.json'),
    ];
    for (const f of all) expect(code(f), f).not.toMatch(/\u2014/);
  });
});
