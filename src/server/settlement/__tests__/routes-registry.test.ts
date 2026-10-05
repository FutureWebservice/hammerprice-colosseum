/**
 * The contract's route table against the files on disk, for the CHAIN routes: every route CHAIN owns exists with its method
 * and no other; and no route file can reach a server key or a balance read (the only place a key is touched is the service
 * layer, and no route returns anything but a service's contract-shaped answer).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTES } from '@/contracts';

const root = path.resolve(__dirname, '../../../app/api');
const fileFor = (p: string) => path.join(root, ...p.replace(/^\/api\//, '').split('/').map((s) => (s.startsWith(':') ? `[${s.slice(1)}]` : s)), 'route.ts');
const chainRoutes = Object.entries(ROUTES).filter(([, r]) => r.agent === 'CHAIN');

describe('CHAIN routes in contracts/api.ts', () => {
  it('there are 8 and each is a route file exporting exactly its method', () => {
    expect(chainRoutes).toHaveLength(8);
    for (const [name, r] of chainRoutes) {
      const f = fileFor(r.path);
      expect(fs.existsSync(f), `${name}: ${f}`).toBe(true);
      const src = fs.readFileSync(f, 'utf8');
      const exported = [...src.matchAll(/export const (GET|POST|PATCH|DELETE)\b/g)].map((m) => m[1]);
      expect(exported, name).toEqual([r.method]);
    }
  });
  it('the cached route is cached and nothing else is (cache modes come from the contract)', () => {
    for (const [name, r] of chainRoutes) {
      const src = fs.readFileSync(fileFor(r.path), 'utf8');
      if (r.cache === 'none') expect(src, name).not.toMatch(/cdnS/);
      else expect(src, name).toContain(`cdnS: ${r.cache.cdnS}`);
    }
  });
  it('no CHAIN route file imports the key loader, the RPC client or a balance read', () => {
    for (const [name, r] of chainRoutes) {
      const src = fs.readFileSync(fileFor(r.path), 'utf8');
      expect(src, name).not.toMatch(/lib\/chain\/(keys|rpc|funds|port)|secretKey|SECRET_KEY|getBalance|lamports/i);
    }
  });
});
