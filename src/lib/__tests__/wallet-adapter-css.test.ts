import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..', '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('wallet adapter stylesheet copy', () => {
  it('is the package file minus the Google Fonts import, with DM Sans from next/font', () => {
    const pkg = read('node_modules/@solana/wallet-adapter-react-ui/styles.css');
    const expected = pkg.split('\n').slice(1).join('\n').replaceAll("'DM Sans', 'Roboto'", "var(--font-dm-sans), 'Roboto'");
    const ours = read('src/styles/wallet-adapter.css');
    expect(pkg.split('\n')[0]).toContain('fonts.googleapis.com');
    expect(ours.slice(ours.indexOf('*/') + 2).trim()).toBe(expected.trim());
    expect(ours).not.toContain('googleapis');
  });
});
