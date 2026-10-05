/**
 * The listing draft (WP6a): validates the request, takes the credit and the budget reservation in ONE locked transaction, calls the model,
 * checks and filters what comes back, and returns a draft the seller must review. Order and guarantees:
 *
 *   1. no model configured            -> template, no credit, no cost
 *   2. daily or monthly budget spent  -> template, no credit, no cost (the hard cap)
 *   3. no credit left                 -> 402 with the payment terms (the route builds the body)
 *   4. reserve the worst-case cost + book (-1, 'usage', key) in one transaction; the same request id twice books once
 *   5. model call -> zod -> filter.   Any failure, a refused draft or a blocked answer: (+1, 'refund', key) and the template.
 *      `not_a_card` also refunds, and answers 400.
 * The model's titles and descriptions pass filter.ts; its price and rationale are never used: the opening price comes from the seller's own
 * estimate (template.ts) and the rationale text is ours. Nothing is stored but counts: no prompt, no photo, no draft.
 */
import { z } from 'zod';
import type { db as DbInstance } from '@/db';
import { AiListingFields, ApiError, type AiListingRequest as RequestSchema, type AiListingResponse as ResponseSchema } from '@/contracts';
import { balanceOf, book } from '../credits/ledger';
import { hasRoom, lockBudget, reserve, settle } from './budget';
import { aiConfig, aiConfigured, aiFree, costMicroUsd, MAX_OUTPUT_LISTING, RESERVE_LISTING_MICRO } from './config';
import { cleanField, isRejected } from './filter';
import { generateJson, usageOf, type GeminiDeps } from './gemini';
import { AiError } from './errors';
import { LISTING_SCHEMA, LISTING_SYSTEM, listingParts } from './prompt';
import { rationaleFor, suggestOpening, templateDraft } from './template';

type Db = typeof DbInstance;
type Request = z.infer<typeof RequestSchema>;
export type ListingResponse = z.infer<typeof ResponseSchema>;
type Fields = z.infer<typeof AiListingFields>;

export const MAX_IMAGE_BYTES = 600 * 1024;

/** What the model is asked for. Anything else it adds is dropped by zod. */
const ModelDraft = z.object({
  error: z.enum(['none', 'not_a_card']),
  titleDe: z.string().max(400), titleEn: z.string().max(400), descriptionDe: z.string().max(6000), descriptionEn: z.string().max(6000),
});

export interface ListingDeps {
  db: Db;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  cluster: string;
  gemini?: GeminiDeps;
}

/** The refusal of a call without credit: the route turns it into the 402 body (it knows the fee wallet, mint and cluster). */
export class PaymentRequired extends ApiError {
  constructor() { super('payment_required', 'You have no listing draft credits left. A pack of 10 costs 1 USDC.'); }
}

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** Photos: canonical base64, at most 600 KB each, and the bytes must be what the media type says. The server never fetches an image URL. */
export function checkImages(images: { mediaType: string; dataBase64: string }[] = []): void {
  for (const [i, im] of images.entries()) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(im.dataBase64)) throw new ApiError('validation', `images.${i}: not base64`);
    const bytes = Buffer.from(im.dataBase64, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new ApiError('validation', `images.${i}: larger than ${MAX_IMAGE_BYTES / 1024} KB`);
    if (!MAGIC[im.mediaType]?.(bytes)) throw new ApiError('validation', `images.${i}: not a ${im.mediaType} image`);
  }
}

// Known limit: a replay of a finished request id is answered from this per-instance memory; a cold instance answers 409 "already created" instead
// (the credit stays booked once). Store the draft in a table if replays across instances ever matter.
const recent = new Map<string, { at: number; res: ListingResponse }>();
const REPLAY_MS = 10 * 60_000;
const remember = (key: string, res: ListingResponse) => {
  if (recent.size > 200) recent.clear();
  recent.set(key, { at: Date.now(), res });
};
export const clearReplayCache = (): void => recent.clear();

const isUniqueViolation = (e: unknown): boolean => {
  const c = e as { code?: string; cause?: { code?: string } };
  return c?.code === '23505' || c?.cause?.code === '23505';
};

function templateResponse(f: Fields, creditsLeft: number): ListingResponse {
  return { draft: templateDraft(f), source: 'template', creditsLeft, label: 'ai_draft' };
}

/** The mock model (AI_MOCK=1, never on production): plausible text built from the card data, and an obedient victim when the name says ATTACK. */
function mockDraft(f: Fields) {
  if (/ATTACK/i.test(f.name)) return { error: 'none', titleDe: 'Gratis, garantiert echt', titleEn: 'Free', descriptionDe: `Siehe ${['https:', '', 'evil.example.com'].join('/')} und überweise an 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin`, descriptionEn: 'This is a guaranteed investment.' };
  if (/NOTACARD/i.test(f.name)) return { error: 'not_a_card', titleDe: 'x', titleEn: 'x', descriptionDe: 'x', descriptionEn: 'x' };
  const label = [f.gradingCompany, f.grade].filter(Boolean).join(' ');
  return {
    error: 'none',
    titleDe: [f.name, label].filter(Boolean).join(', ').slice(0, 70), titleEn: [f.name, label].filter(Boolean).join(', ').slice(0, 70),
    descriptionDe: `Sammelkarte ${f.name}${f.setName ? ` aus dem Set ${f.setName}` : ''}${label ? `, Grading laut Label: ${label}` : ''}. Dieser Entwurf stammt von einem KI-Modell (Testmodus) und muss vom Verkäufer geprüft werden.`,
    descriptionEn: `Trading card ${f.name}${f.setName ? ` from the set ${f.setName}` : ''}${label ? `, grading per the label: ${label}` : ''}. This draft was written by an AI model (test mode) and must be reviewed by the seller.`,
  };
}

export async function createListing(profile: { id: string }, req: Request, deps: ListingDeps): Promise<ListingResponse> {
  const { db } = deps;
  const env = deps.env ?? process.env;
  const now = () => (deps.now ?? (() => new Date()))();
  const f = req.fields;
  checkImages(req.images);
  const key = `${profile.id}:${req.requestId}`;

  const cached = recent.get(key);
  if (cached && Date.now() - cached.at < REPLAY_MS) return cached.res;

  const cfg = aiConfig(env);
  const free = aiFree(env); // AI_FREE: no credit is required, debited or refunded; the budget reservation and every limit stay
  if (!aiConfigured(env)) return templateResponse(f, await balanceOf(db, profile.id)); // (1)

  // (2)-(4): one transaction, one lock.
  let usageId: string;
  try {
    const gate = await db.transaction(async (tx) => {
      await lockBudget(tx);
      if (!(await hasRoom(tx, cfg, RESERVE_LISTING_MICRO, now()))) return { kind: 'budget' as const, balance: await balanceOf(tx, profile.id) };
      const balance = await balanceOf(tx, profile.id);
      if (!free && balance < 1) return { kind: 'credit' as const };
      const id = await reserve(tx, { profileId: profile.id, requestId: key, kind: 'listing', model: cfg.model, provider: cfg.mock ? 'mock' : cfg.provider, cluster: deps.cluster, reserveMicro: RESERVE_LISTING_MICRO }, now());
      if (!free) await book(tx, profile.id, -1, 'usage', key);
      return { kind: 'go' as const, id };
    });
    if (gate.kind === 'budget') return templateResponse(f, gate.balance);
    if (gate.kind === 'credit') throw new PaymentRequired();
    usageId = gate.id;
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError('wrong_state', 'This draft was already requested. If you did not receive it, start a new draft; a failed one is refunded automatically.');
    throw e;
  }

  const refundAndTemplate = async (status: 'error' | 'refused', costMicro: number, usage: ReturnType<typeof usageOf>): Promise<ListingResponse> => {
    await settle(db, usageId, { status, costMicro, usage });
    if (!free) await book(db, profile.id, 1, 'refund', key);
    const res = templateResponse(f, await balanceOf(db, profile.id));
    remember(key, res);
    return res;
  };

  // (5)
  let out: Awaited<ReturnType<typeof generateJson>>;
  try {
    out = await generateJson({ system: LISTING_SYSTEM, parts: listingParts(f, req.images), schema: LISTING_SCHEMA, maxOutputTokens: MAX_OUTPUT_LISTING, mock: () => mockDraft(f) }, { env, ...deps.gemini });
  } catch (e) {
    const usage = usageOf(e);
    console.warn('ai listing call failed', e instanceof AiError ? `${e.kind}${e.status ? ' ' + e.status : ''}` : 'unexpected'); // kind and status only, never text
    return refundAndTemplate('error', usage ? costMicroUsd(usage, cfg.model) : 0, usage);
  }
  const cost = costMicroUsd(out.usage, out.model);
  const parsed = ModelDraft.safeParse(out.json);
  if (!parsed.success) return refundAndTemplate('refused', cost, out.usage);
  if (parsed.data.error === 'not_a_card') {
    await settle(db, usageId, { status: 'refused', costMicro: cost, usage: out.usage });
    if (!free) await book(db, profile.id, 1, 'refund', key);
    throw new ApiError('validation', 'This does not look like a trading card, so no draft was made. Your credit was returned.');
  }
  const allow = [f.grade ?? ''].filter(Boolean); // the printed grade of this card may be quoted (CGC "PRISTINE 10")
  const titleDe = cleanField(parsed.data.titleDe, { max: 80, title: true, allow }), titleEn = cleanField(parsed.data.titleEn, { max: 80, title: true, allow });
  const descriptionDe = cleanField(parsed.data.descriptionDe, { max: 1500, min: 20, allow }), descriptionEn = cleanField(parsed.data.descriptionEn, { max: 1500, min: 20, allow });
  if (isRejected(titleDe) || isRejected(titleEn) || isRejected(descriptionDe) || isRejected(descriptionEn)) return refundAndTemplate('refused', cost, out.usage);

  await settle(db, usageId, { status: 'ok', costMicro: cost, usage: out.usage });
  const opening = suggestOpening(f.estimateUsdc);
  const res: ListingResponse = {
    draft: { titleDe, titleEn, descriptionDe, descriptionEn, suggestedOpeningUsdc: opening, rationale: rationaleFor(opening, f.locale) },
    source: 'model', creditsLeft: await balanceOf(db, profile.id), label: 'ai_draft',
  };
  remember(key, res);
  return res;
}
