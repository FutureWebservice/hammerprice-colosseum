import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import en from '@/locales/en/features.json';
import de from '@/locales/de/features.json';
import { IDEATHON_LINE } from '@/components/landing/site';
import { SITE_ROUTES, findRoute } from '@/lib/site-routes';
import { FEATURES, FEATURE_IDS, allOnEnv, clusterOf, featureStatus, linkOf, statusKey, type FeatureEntry } from '../features';
import { Keypair } from '@solana/web3.js';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';
import { botConfig } from '@/server/telegram/config';
import { videoConfig } from '@/server/streams/paths';

const ROOT = process.cwd();
const entry = (id: string): FeatureEntry => FEATURES.find((f) => f.id === id)!;
const strings = (o: unknown, out: string[] = []): string[] => {
  if (typeof o === 'string') out.push(o);
  else if (Array.isArray(o)) o.forEach((v) => strings(v, out));
  else if (o && typeof o === 'object') Object.values(o).forEach((v) => strings(v, out));
  return out;
};
const DEVNET = allOnEnv('devnet');
/** allOnEnv plus what a ready mainnet deployment needs (inspectCluster): RPC, fee wallet and readable keys, all throwaway. */
const mainnetReady = (): Record<string, string> => {
  const key = () => JSON.stringify(Array.from(Keypair.generate().secretKey));
  const env = allOnEnv('mainnet-beta');
  env.SOLANA_RPC_URL = ['https:', '', 'rpc.example.org'].join('/');
  env.PLATFORM_WALLET_ADDRESS = Keypair.generate().publicKey.toBase58();
  env.SETTLEMENT_AUTHORITY_SECRET_KEY = key();
  env.VRF_SECRET_KEY = key();
  return env;
};
const MAINNET = mainnetReady();

describe('registry', () => {
  it('lists the sections in the agreed order, once each', () => {
    expect(FEATURES.map((f) => f.id)).toEqual(['settlement', 'verify', 'random', 'timed', 'room', 'chat', 'ai', 'packs', 'video', 'telegram', 'wallets', 'ideathon']);
    expect(new Set(FEATURE_IDS).size).toBe(FEATURE_IDS.length);
  });

  it('has evidence in the build for every built feature', () => {
    for (const f of FEATURES) {
      if (f.built) for (const file of f.evidence.files) expect(fs.existsSync(path.join(ROOT, file)), `${f.id}: ${file}`).toBe(true);
      else for (const file of f.evidence.absent ?? []) expect(fs.existsSync(path.join(ROOT, file)), `${f.id} is marked as not built but ${file} exists: set built: true and add its evidence files`).toBe(false);
    }
    expect(entry('telegram').built).toBe(true);
  });

  it('writes no cluster, mint or host into feature code', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/content/features.ts'), 'utf8');
    expect(src).not.toMatch(/EPjFW|4zMMC9|solana\.com|helius|explorer\.|https?:\/\//);
  });
});

describe('featureStatus on devnet with everything on', () => {
  const s = (id: string) => featureStatus(entry(id), DEVNET);
  it('labels each feature by what it is', () => {
    expect(['settlement', 'verify', 'random', 'timed', 'room', 'chat', 'ai', 'wallets'].map(s)).toEqual(Array(8).fill('live'));
    expect(s('packs')).toBe('demo');
    expect(s('video')).toBe('optional');
    expect(s('telegram')).toBe('live');
    expect(s('ideathon')).toBeNull();
  });
  it('says "live on devnet" and nothing about mainnet', () => {
    expect(clusterOf(DEVNET)).toBe('devnet');
    expect(statusKey('live', 'devnet')).toBe('liveDevnet');
  });
});

describe('featureStatus on mainnet with everything on', () => {
  const s = (id: string) => featureStatus(entry(id), MAINNET);
  it('follows SOLANA_CLUSTER: packs are no demo, the house room does not exist, labels name mainnet', () => {
    expect(clusterOf(MAINNET)).toBe('mainnet-beta');
    expect(s('packs')).toBe('live');
    expect(s('room')).toBe('off');
    expect(s('video')).toBe('optional');
    expect(s('settlement')).toBe('live');
    expect(statusKey('live', 'mainnet-beta')).toBe('liveMainnet');
  });
  it('also follows the browser-side network variable and refuses a contradiction', () => {
    expect(clusterOf({ NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta' })).toBe('mainnet-beta');
    expect(clusterOf({ SOLANA_CLUSTER: 'devnet', NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta' })).toBeNull();
    expect(featureStatus(entry('settlement'), { SOLANA_CLUSTER: 'devnet', NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta' })).toBe('off');
    expect(featureStatus(entry('settlement'), { SOLANA_CLUSTER: 'nonsense' })).toBe('off');
  });
});

describe('featureStatus when the cluster is not ready', () => {
  const ids = ['settlement', 'verify', 'wallets', 'random', 'packs'];
  it('is "off" on mainnet without RPC, fee wallet and settlement key', () => {
    const env = { ...MAINNET };
    delete env.SOLANA_RPC_URL; delete env.PLATFORM_WALLET_ADDRESS; delete env.SETTLEMENT_AUTHORITY_SECRET_KEY;
    for (const id of ids) expect(featureStatus(entry(id), env), id).toBe('off');
  });
  it('is "off" with a USDC mint that belongs to the other network', () => {
    const wrong = Keypair.generate().publicKey.toBase58();
    for (const id of ids) expect(featureStatus(entry(id), { ...MAINNET, USDC_MINT: wrong }), id).toBe('off');
    for (const id of ids) expect(featureStatus(entry(id), { ...DEVNET, USDC_MINT: MAINNET_USDC_MINT }), id).toBe('off');
  });
  it('needs the house seller key for the house room', () => {
    const env = { ...DEVNET };
    delete env.HOUSE_SELLER_SECRET_KEY;
    expect(featureStatus(entry('room'), env)).toBe('off');
    expect(featureStatus(entry('room'), { SOLANA_CLUSTER: 'devnet' })).toBe('off');
  });
});

describe('featureStatus when a switch or a needed variable is missing', () => {
  it.each(['devnet', 'mainnet-beta'] as const)('is "off" without the switch (%s)', (c) => {
    for (const [id, flag] of [['random', 'VRF'], ['timed', 'TIMED'], ['chat', 'CHAT'], ['ai', 'AI'], ['packs', 'PACKS'], ['video', 'VIDEO']] as const) {
      const env = c === 'devnet' ? { ...DEVNET } : { ...MAINNET };
      delete env[`FEATURE_${flag}`];
      expect(featureStatus(entry(id), env), id).toBe('off');
      expect(featureStatus(entry(id), { ...env, [`FEATURE_${flag}`]: 'TRUE' }), `${id}: only "true" counts`).toBe('off');
    }
  });
  it('is "off" without the variable the feature needs', () => {
    for (const [id, name] of [['random', 'VRF_SECRET_KEY'], ['packs', 'VRF_SECRET_KEY'], ['video', 'MEDIA_SERVER_URL'], ['ai', 'GEMINI_API_KEY']] as const) {
      const env = { ...DEVNET };
      delete env[name];
      expect(featureStatus(entry(id), env), id).toBe('off');
    }
    expect(featureStatus(entry('ai'), { ...DEVNET, GEMINI_API_KEY: '', GCP_SERVICE_ACCOUNT_JSON: 'set' })).toBe('live');
    expect(featureStatus(entry('ai'), { ...DEVNET, GEMINI_API_KEY: '  ' })).toBe('off');
  });
  it('keeps core features on without any switch', () => {
    for (const id of ['settlement', 'verify', 'wallets']) expect(featureStatus(entry(id), { SOLANA_CLUSTER: 'devnet' })).toBe('live');
  });
  it('calls Telegram off until its switch and all three bot variables are set', () => {
    expect(featureStatus(entry('telegram'), { ...DEVNET, TELEGRAM_WEBHOOK_SECRET: '' })).toBe('off');
    expect(featureStatus(entry('telegram'), { ...DEVNET, FEATURE_TELEGRAM: '' })).toBe('off');
  });
  it('checks the FORMAT of the three Telegram names with the validator of src/server/telegram/config.ts', () => {
    expect(botConfig(DEVNET)).not.toBeNull();
    for (const [name, bad] of [['TELEGRAM_BOT_TOKEN', 'set'], ['TELEGRAM_BOT_TOKEN', '123:short'], ['TELEGRAM_BOT_USERNAME', 'x'], ['TELEGRAM_WEBHOOK_SECRET', 'short'], ['TELEGRAM_WEBHOOK_SECRET', `${'a'.repeat(20)} ${'b'.repeat(20)}`]] as const) {
      const env = { ...DEVNET, [name]: bad };
      expect(botConfig(env), `${name}=${bad}`).toBeNull();
      expect(featureStatus(entry('telegram'), env), `${name}=${bad}`).toBe('off');
    }
    // the feature and the badge agree on the leading @ of the username
    expect(featureStatus(entry('telegram'), { ...DEVNET, TELEGRAM_BOT_USERNAME: '@ExampleHammerBot' })).toBe('live');
  });
  it('video needs the media server host AND both publish credentials, and the host must be one videoConfig accepts', () => {
    expect(entry('video').needsAll).toEqual(['MEDIA_SERVER_URL', 'MEDIAMTX_PUBLISH_USER', 'MEDIAMTX_PUBLISH_PASS']);
    expect(videoConfig(DEVNET)).not.toBeNull();
    for (const name of ['MEDIAMTX_PUBLISH_USER', 'MEDIAMTX_PUBLISH_PASS', 'MEDIA_SERVER_URL']) {
      const env = { ...DEVNET };
      delete env[name];
      expect(featureStatus(entry('video'), env), name).toBe('off');
    }
    // a name that is set but that the video code refuses (a loopback host on a real deployment) is not "optional"
    expect(featureStatus(entry('video'), { ...DEVNET, MEDIA_SERVER_URL: 'localhost' })).toBe('off');
    expect(featureStatus(entry('video'), { ...DEVNET, MEDIA_SERVER_URL: 'not a host' })).toBe('off');
  });
  it('keeps the AI badge off in AI_MOCK mode on purpose (the mock is for tests)', () => {
    const env: Record<string, string> = { ...DEVNET, AI_MOCK: '1' };
    delete env.GEMINI_API_KEY;
    expect(featureStatus(entry('ai'), env)).toBe('off');
  });
});

describe('links', () => {
  it('resolve to a built route, and only show while the feature runs', () => {
    for (const f of FEATURES.filter((x) => x.link)) {
      expect(findRoute(f.link!, SITE_ROUTES.filter((r) => r.exists)), f.id).toBeDefined();
      expect(linkOf(f, 'live')).toBe(f.link);
      expect(linkOf(f, 'demo')).toBe(f.link);
      expect(linkOf(f, 'optional')).toBe(f.link);
      expect(linkOf(f, 'off')).toBeNull();
      expect(linkOf(f, 'planned')).toBeNull();
    }
  });
  it('has no /features page and no navigation entry', () => {
    expect(SITE_ROUTES.map((r) => r.path)).not.toContain('/features');
    expect(fs.existsSync(path.join(ROOT, 'src/app/[locale]/features'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/app/features'))).toBe(false);
    for (const l of ['en', 'de']) expect(fs.readFileSync(path.join(ROOT, `src/locales/${l}/nav.json`), 'utf8')).not.toMatch(/features/i);
  });
});

describe('the words', () => {
  it('have the same keys in German and English', () => {
    const keys = (o: unknown, p = ''): string[] =>
      Array.isArray(o) ? o.flatMap((v, i) => keys(v, `${p}${i}.`)) : o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p];
    expect(keys(de).sort()).toEqual(keys(en).sort());
  });
  it.each([['en', en], ['de', de]] as const)('give every section a title, a sentence, exactly three short steps and its limits (%s)', (_l, m) => {
    for (const f of FEATURES) {
      const item = m.items[f.id] as { title: string; lead?: string; steps?: { title: string; body: string }[]; limits?: string; cta?: string };
      expect(item.title.length, f.id).toBeGreaterThan(2);
      if (f.kind === 'mention') continue;
      expect(item.lead, f.id).toBeTruthy();
      expect(item.steps, f.id).toHaveLength(3);
      for (const st of item.steps!) {
        expect(st.title.length).toBeLessThanOrEqual(24);
        expect(st.body.length, `${f.id}: ${st.body}`).toBeLessThanOrEqual(110);
      }
      expect(item.limits, f.id).toBeTruthy();
      if (f.link) expect(item.cta, `${f.id} has a link and needs a label`).toBeTruthy();
    }
    for (const k of ['liveDevnet', 'liveMainnet', 'demo', 'optional', 'off', 'planned'] as const) expect(m.status[k].length).toBeGreaterThan(2);
  });
  it.each([['en', en], ['de', de]] as const)('use no dash as a sentence break, no gradient word and no claim the build cannot back (%s)', (_l, m) => {
    for (const s of strings(m)) {
      expect(s).not.toMatch(/[\u2014–]/);
      expect(s).not.toMatch(/gradient|Farbverlauf/i);
    }
    const body = strings(m.items).join('\n');
    expect(body).not.toMatch(/real money|echtes Geld|guarantee|garantiert|open source|open-source|ideathon|ranked|\b(won|gewonnen)\b|latency|Latenz|mainnet/i);
  });
  it('says plainly what Telegram does and that it never bids, and keeps the badge text in the code, not in the sentences', () => {
    expect(en.items.telegram.limits).toMatch(/never bids for you/);
    expect(de.items.telegram.limits).toMatch(/bietet nie für Sie/);
    expect(en.items.telegram.lead).toMatch(/^A Telegram bot, @hammerpricebot/);
    expect(de.items.telegram.lead).toMatch(/^Ein Telegram-Bot, @hammerpricebot/);
    for (const m of [en, de]) for (const f of FEATURES) expect(strings(m.items[f.id]).join(' ')).not.toMatch(/Live (on|auf) (devnet|mainnet)|Switched off on this site|Auf dieser Seite aus/i);
  });
  it('uses the wording of the site: minimum price, bidding number', () => {
    const t = strings(en.items).join(' ');
    expect(t).toMatch(/minimum price/);
    expect(t).toMatch(/bidding number/);
    expect(strings(de.items).join(' ')).toMatch(/Mindestpreis/);
    expect(strings(de.items).join(' ')).toMatch(/Bieternummer/);
  });
  it('keeps the ideathon line as the owner wrote it, in code and never in the locale file', () => {
    expect(strings(en).join(' ')).not.toContain(IDEATHON_LINE.en);
    expect(IDEATHON_LINE.en).toBe("One of ten prize winners at Superteam Germany's Road to Colosseum Ideathon");
    expect(IDEATHON_LINE.de).toBe('Einer von zehn Preisträgern beim Road-to-Colosseum-Ideathon von Superteam Germany');
  });
});
