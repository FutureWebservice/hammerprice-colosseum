/**
 * The fixed knowledge base of the assistant. Built from the site's own texts so there is ONE source: the answers are the assistant's
 * question list in `explain.json` (`assistant`: the five "short version" answers and the groups). The About page FAQ shows only the
 * questions its other sections do not already answer, so this list is kept apart and is not rendered. Plus a few short entries of our
 * own in `ai.json` ("ask.extra").
 * The assistant never writes an answer: the model only picks a key from this list and the server returns the text stored here.
 *
 * Entries that talk about the test network (devnet, test USDC) are dropped on mainnet, so the assistant never repeats a statement that is
 * only true on the other cluster. Pure: no I/O.
 */
import type { Cluster } from '@/contracts';
import deExplain from '@/locales/de/explain.json';
import enExplain from '@/locales/en/explain.json';
import deAi from '@/locales/de/ai.json';
import enAi from '@/locales/en/ai.json';

export type Lang = 'de' | 'en';
export interface FaqEntry {
  key: string;
  q: Record<Lang, string>;
  a: Record<Lang, string>;
  /** Only true on the test network: not offered on mainnet. */
  testOnly: boolean;
  /** An entry of our own (ai.json) rather than the site FAQ: it loses a keyword tie against the FAQ. */
  extra: boolean;
  /** The answer says where the live numbers are; the room panel appends them from the public snapshot. */
  live: boolean;
}

type QA = { q: string; a: string };
interface Explain { assistant: { quick: { items: QA[] }; groups: { id: string; items: QA[] }[] } }
interface AiMessages { ask: { extra: Record<string, { q?: string; a: string; live?: boolean; testOnly?: boolean }> } }

const TEST_RE = /devnet|test network|testnet|test usdc|test-usdc|testnetz|testnetzwerk|testgeld/i;

function explainEntries(): FaqEntry[] {
  const de = deExplain as unknown as Explain, en = enExplain as unknown as Explain;
  const out: FaqEntry[] = [];
  const push = (key: string, d: QA | undefined, e: QA | undefined) => {
    if (!d || !e) return;
    out.push({ key, q: { de: d.q, en: e.q }, a: { de: d.a, en: e.a }, testOnly: key.startsWith('devnet.') || TEST_RE.test(`${e.q} ${e.a} ${d.q} ${d.a}`), live: false, extra: false });
  };
  en.assistant.quick.items.forEach((e, i) => push(`quick.${i}`, de.assistant.quick.items[i], e));
  en.assistant.groups.forEach((g) => { const dg = de.assistant.groups.find((x) => x.id === g.id); g.items.forEach((e, i) => push(`${g.id}.${i}`, dg?.items[i], e)); });
  return out;
}

/** Whole group `devnet` and every entry that names the test network are test-only. Entries of our own; `no_advice` and `cannot` are handled by the caller and are not offered to the model as choices. */
export const SPECIAL_KEYS = ['no_advice', 'cannot'] as const;

function extraEntries(): FaqEntry[] {
  const de = (deAi as unknown as AiMessages).ask.extra, en = (enAi as unknown as AiMessages).ask.extra;
  return Object.entries(en).filter(([k]) => !(SPECIAL_KEYS as readonly string[]).includes(k) && de[k]).map(([key, e]) => ({
    key, q: { de: de[key]!.q ?? '', en: e.q ?? '' }, a: { de: de[key]!.a, en: e.a }, testOnly: e.testOnly === true, live: e.live === true, extra: true,
  }));
}

const ALL = [...explainEntries(), ...extraEntries()];

export const allFaq = (): readonly FaqEntry[] => ALL;
/** The entries valid on this cluster. */
export const faqFor = (cluster: Cluster): FaqEntry[] => ALL.filter((e) => cluster !== 'mainnet-beta' || !e.testOnly);
export const faqByKey = (key: string, cluster: Cluster): FaqEntry | undefined => faqFor(cluster).find((e) => e.key === key);

/** The fixed texts for "no advice" and "I cannot answer that". */
export const fixedText = (which: (typeof SPECIAL_KEYS)[number], lang: Lang): string => ((lang === 'de' ? deAi : enAi) as unknown as AiMessages).ask.extra[which]!.a;
