/**
 * What must NOT be in the script a page loads first. The wallet adapter and the Solana client weigh about 430 kB
 * before compression, the explain texts 45 kB, and the settlement code 300 kB: all of them load late. This reads the STATIC import graph from the entries, so a
 * plain `import` that puts one of them back fails here, before a build is made.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { staticPackages, SRC } from '../i18n/__tests__/namespace-graph';

const A = (p: string) => path.join(SRC, p);
const HEAVY = ['@solana/web3.js', '@solana/wallet-adapter-react-ui', '@solana/wallet-adapter-react/lib', '@solana-mobile', 'qrcode'];

describe('late loading', () => {
  it('the locale layout (every page) imports no wallet adapter UI, no Solana client and no explain texts statically', () => {
    const hit = staticPackages([A('app/[locale]/layout.tsx')], HEAVY);
    // The layout may import the adapter's context and hook (a few kB, tree-shaken); the provider, the modal and web3.js are the weight.
    expect([...hit.entries()], 'static imports of heavy packages from the layout').toEqual([]);
    const files = fs.readFileSync(A('components/explain/ExplainBubble.tsx'), 'utf8');
    expect(files, 'the bubble loads its dialog late').not.toMatch(/from '\.\/(ExplainContent|content)'/);
    expect(files).toMatch(/import\('\.\/ExplainDialog'\)/);
  });

  it('the wallet host is reached only through a dynamic import', () => {
    const provider = fs.readFileSync(A('components/wallet/WalletProvider.tsx'), 'utf8');
    expect(provider).toMatch(/import\('\.\/WalletHost'\)/);
    expect(provider).not.toMatch(/from '\.\/WalletHost'/);
    const hit = staticPackages([A('components/wallet/WalletProvider.tsx')], ['@solana/wallet-adapter-react-ui', '@solana/web3.js']);
    expect([...hit.entries()]).toEqual([]);
  });

  it('the room imports no Solana client statically: the settlement round loads with the pay dialog', () => {
    const hit = staticPackages([A('components/auction/AuctionRoom.tsx')], ['@solana/web3.js', '@solana/spl-token', '@solana/wallet-adapter-react-ui']);
    expect([...hit.entries()], 'static imports of the Solana client from the room').toEqual([]);
    // Control: the reader does see the Solana client where it is imported (the pay dialog).
    expect(staticPackages([A('components/room/PayModal.tsx')], ['@solana/web3.js']).has('@solana/web3.js')).toBe(true);
    const room = fs.readFileSync(A('components/auction/AuctionRoom.tsx'), 'utf8');
    expect(room).toMatch(/from '@\/components\/room\/lazy'/);
  });

  it('the schedule and the session code do not import the API schemas (zod) statically', () => {
    const hit = staticPackages([A('components/sell/Schedule.tsx'), A('lib/client/session.ts')], ['zod']);
    // contracts/* import zod; a static import of them from these entries would carry it. Type-only imports are skipped by the reader.
    expect([...hit.entries()]).toEqual([]);
    const reaches = staticPackages([A('components/sell/Schedule.tsx'), A('lib/client/session.ts')], ['@/contracts']);
    expect([...reaches.entries()]).toEqual([]);
  });
});

describe('the room page is cached by the CDN', () => {
  it('is made on demand and kept for a minute (the room data is fetched by the browser)', () => {
    const page = fs.readFileSync(A('app/[locale]/room/[id]/page.tsx'), 'utf8');
    expect(page).toMatch(/export const revalidate = 60;/);
    expect(page).toMatch(/export function generateStaticParams\(\)/);
  });
});
