import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ConsignStatus, LotState, NftStandard, SettlementStatus, ShowStatus } from '@/contracts/common';
import { ERROR_CODES } from '@/contracts/errors';
import { READINESS_REASONS } from '@/contracts/chain';
import { STEPS } from '../wizardState';

const SRC = path.join(__dirname, '..', '..', '..');
const NS = ['sell', 'account', 'rooms'] as const;
type Tree = { [k: string]: string | Tree };
const load = (locale: string, ns: string): Tree => JSON.parse(fs.readFileSync(path.join(SRC, 'locales', locale, `${ns}.json`), 'utf8'));
const flat = (o: Tree, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
const get = (o: Tree, key: string): unknown => key.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Tree)[k] : undefined), o);

describe('sell, account and rooms messages', () => {
  it.each(NS)('%s has the same keys in en and de', (ns) => {
    expect(flat(load('de', ns)).sort()).toEqual(flat(load('en', ns)).sort());
  });

  it.each(NS)('%s has no em dash, no empty message and no placeholder text in either language', (ns) => {
    for (const l of ['en', 'de']) {
      const text = fs.readFileSync(path.join(SRC, 'locales', l, `${ns}.json`), 'utf8');
      expect(text, `${l}/${ns}`).not.toContain('\u2014');
      expect(text, `${l}/${ns}`).not.toMatch(/:\s*""/);
      expect(text, `${l}/${ns}`).not.toMatch(/TODO|lorem|XXX/i);
    }
  });

  it('keeps ICU placeholders identical between en and de (a dropped {name} would print nothing)', () => {
    const vars = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]))].sort();
    for (const ns of NS) {
      const en = load('en', ns);
      const de = load('de', ns);
      for (const k of flat(en)) expect(vars(get(de, k) as string), `${ns}.${k}`).toEqual(vars(get(en, k) as string));
    }
  });

  it('has words for every enum the pages print', () => {
    const en = { sell: load('en', 'sell'), account: load('en', 'account'), rooms: load('en', 'rooms') };
    const need: [keyof typeof en, string, readonly string[]][] = [
      ['sell', 'standards', NftStandard.options],
      ['sell', 'reasons', READINESS_REASONS],
      ['sell', 'errors', [...ERROR_CODES, 'network']],
      ['sell', 'manage.status', ShowStatus.options],
      ['sell', 'manage.lotState', LotState.options],
      ['sell', 'manage.consign', ConsignStatus.options],
      ['sell', 'wizard.steps', STEPS],
      ['sell', 'wizard.terms.issues', ['amount_required', 'amount_invalid', 'amount_zero', 'amount_too_large', 'reserve_below_opening']],
      ['sell', 'wizard.show.issues', ['title_required', 'title_too_short', 'title_too_long', 'title_characters', 'start_invalid', 'start_too_soon']],
      ['account', 'status', SettlementStatus.options],
      ['account', 'lotState', LotState.options],
      ['account', 'consign', ConsignStatus.options],
      ['account', 'tabs', ['profile', 'wallet', 'bids', 'payments', 'sales', 'prices', 'credits', 'notifications', 'account']],
      ['account', 'bids.result', ['leading', 'outbid', 'won', 'lost', 'ended']],
      ['account', 'sales', ShowStatus.options],
      ['rooms', 'status', ShowStatus.options],
    ];
    for (const [ns, prefix, keys] of need) for (const k of keys) expect(get(en[ns], `${prefix}.${k}`), `${ns}.${prefix}.${k}`).toBeTypeOf('string');
  });

  it('has a message for every literal t("key") the source uses', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); } else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    for (const d of ['components/sell', 'components/account', 'app/[locale]/sell', 'app/[locale]/account', 'app/[locale]/rooms']) walk(path.join(SRC, d));
    files.push(path.join(SRC, 'components/layout/Header.tsx'));

    const missing: string[] = [];
    let checked = 0;
    for (const f of files) {
      const code = fs.readFileSync(f, 'utf8');
      // `const t = useTranslations('sell')`, `const ta = useTranslations('account')`, `await getTranslations({ locale, namespace: 'rooms' })`
      const bound = new Map<string, Set<string>>();
      for (const m of code.matchAll(/const (\w+) = (?:await )?(?:useTranslations|useTranslationsWithFallback|getTranslations)\((?:\{[^}]*namespace: )?'(\w+)'/g)) {
        (bound.get(m[1]) ?? bound.set(m[1], new Set()).get(m[1])!).add(m[2]);
      }
      for (const [v, spaces] of bound) {
        for (const m of code.matchAll(new RegExp(`\\b${v}\\(\\s*'([\\w.]+)'`, 'g'))) {
          checked++;
          // any namespace that has a message file is checked (the feature slots under components/sell/slots read their own: timed, video, ai)
          const ok = [...spaces].some((ns) => (ns === 'nav' ? true : fs.existsSync(path.join(SRC, 'locales', 'en', `${ns}.json`)) && typeof get(load('en', ns), m[1]) === 'string'));
          if (!ok) missing.push(`${path.relative(SRC, f)}: ${[...spaces].join('|')}.${m[1]}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
