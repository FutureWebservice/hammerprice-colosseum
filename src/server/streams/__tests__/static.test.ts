/**
 * Structural promises of the video package, checked on the source: it is cluster-neutral (no chain import anywhere), and nothing the
 * browser loads can reach a credential (no server import and no secret variable name in any client file).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const walk = (dir: string): string[] => fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === '__tests__' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []))
  : [];
const read = (f: string) => fs.readFileSync(f, 'utf8');

const OWN = [
  'src/server/streams', 'src/app/api/streams', 'src/app/api/shows/[id]/video', 'src/lib/streaming', 'src/components/streaming',
  'src/app/[locale]/sell/[showId]/broadcast',
].flatMap((d) => walk(path.join(ROOT, d))).concat(
  ['src/components/room/slots/StageMedia.tsx', 'src/components/sell/slots/VideoOption.tsx', 'src/components/sell/slots/BroadcastLink.tsx'].map((f) => path.join(ROOT, f)),
);

describe('the video package', () => {
  it('has files to check', () => { expect(OWN.length).toBeGreaterThan(15); });

  it('imports nothing from the chain layer or Solana: it runs the same on devnet and mainnet', () => {
    for (const f of OWN) {
      const imports = [...read(f).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const i of imports) expect(i, `${path.relative(ROOT, f)} imports ${i}`).not.toMatch(/lib\/chain|@solana|@metaplex|solana/i);
    }
  });

  it('client files never import server code and never name a secret variable', () => {
    const client = OWN.filter((f) => /^['"]use client['"]/.test(read(f).trimStart()));
    expect(client.length).toBeGreaterThan(5);
    for (const f of client) {
      const src = read(f);
      expect(src, path.relative(ROOT, f)).not.toMatch(/@\/server\/|@\/db|process\.env\.(MEDIA|MEDIAMTX|VIDEO_|FEATURE_)/);
      expect(src, path.relative(ROOT, f)).not.toMatch(/MEDIAMTX_PUBLISH|MEDIA_SERVER_API_KEY|Authorization|Basic /);
    }
  });

  it('the only client reading of the feature is the public NEXT_PUBLIC_FEATURE_VIDEO', () => {
    const hits = OWN.filter((f) => /process\.env\./.test(read(f)) && /^['"]use client['"]/.test(read(f)));
    expect(hits).toEqual([]);
    expect(read(path.join(ROOT, 'src/lib/streaming/client-flag.ts'))).toContain('NEXT_PUBLIC_FEATURE_VIDEO');
  });

  it('no console output anywhere in the package (the production build keeps warn and error)', () => {
    for (const f of OWN) expect(read(f), path.relative(ROOT, f)).not.toMatch(/console\.(log|warn|error|info|debug)/);
  });

  it('writes only under the hp prefix and never names the live prefix of the shared server', () => {
    for (const f of OWN) expect(read(f), path.relative(ROOT, f)).not.toMatch(/['"`]live\//);
  });
});
