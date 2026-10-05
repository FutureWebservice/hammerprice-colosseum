import { describe, expect, it } from 'vitest';
import { ROUTES } from '@/contracts';
import { PACK_PATHS } from '../api';

describe('PACK_PATHS', () => {
  it('repeats exactly the paths of the PACKS routes in the contract, so a drift fails here and not in a demo', () => {
    for (const [key, path] of Object.entries(PACK_PATHS)) expect(ROUTES[key as keyof typeof ROUTES].path, key).toBe(path);
    const packRoutes = Object.keys(ROUTES).filter((k) => ROUTES[k as keyof typeof ROUTES].agent === 'PACKS');
    expect(packRoutes.sort()).toEqual(Object.keys(PACK_PATHS).sort());
  });
});
