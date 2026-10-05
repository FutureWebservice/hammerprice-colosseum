/**
 * The verifier must run in a browser: bundle the public surface (./index) for the browser platform (esbuild refuses Node
 * builtins there), assert the secret-key module and web3.js are not in it, then run the bundle in a sandbox that has no
 * Buffer, process or require, and verify a real request with it.
 */
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { makeWorld } from './testkit';

const root = path.resolve(__dirname, '../../../..');

describe('browser bundle of the verifier', () => {
  it('bundles for the browser, excludes the server key, and verifies with no Node globals', async () => {
    const r = await build({
      entryPoints: [path.join(root, 'src/lib/vrf/index.ts')],
      bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'Vrf', target: 'es2020', metafile: true, minify: true,
      alias: { '@': path.join(root, 'src') }, logLevel: 'silent',
    });
    const inputs = Object.keys(r.metafile!.inputs);
    expect(inputs.some((i) => i.includes('lib/vrf/key.ts'))).toBe(false);
    expect(inputs.some((i) => i.includes('@solana/web3.js'))).toBe(false);
    expect(inputs.some((i) => /node:|\/crypto-browserify|buffer\//.test(i))).toBe(false);
    const code = r.outputFiles[0]!.text;
    expect(code.length).toBeLessThan(100 * 1024); // it was 137 KB while the zod contracts leaked in
    expect(inputs.some((i) => i.includes('zod'))).toBe(false);

    const w = makeWorld('mainnet-beta');
    const ctx = vm.createContext({ TextEncoder, TextDecoder, structuredClone, result: null as unknown, view: JSON.stringify(w.view) });
    vm.runInContext(code + `;Vrf.verifyRequest(JSON.parse(view)).then((c) => { result = c.map((x) => x.status); });`, ctx);
    await new Promise((res) => setTimeout(res, 100));
    expect((ctx as { result: string[] }).result).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(vm.runInContext('typeof Buffer + typeof process + typeof require', ctx)).toBe('undefinedundefinedundefined');
  });
});
