/**
 * The Gemini adapter: ONE function, plain `fetch`, no SDK. `generateJson` sends a `generateContent` request (the same body for both
 * providers) and returns the parsed JSON plus the token usage. Field names are from the official REST reference (ai.google.dev/api/generate-content,
 * read 2026-10-03): `systemInstruction`, `contents[].parts[]` with `inlineData {mimeType, data}`, `generationConfig` with `responseMimeType`,
 * `responseJsonSchema`, `maxOutputTokens`, `thinkingConfig.thinkingLevel` (enum MINIMAL) and `mediaResolution`, and `usageMetadata` with
 * `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`. Whether the live service accepts exactly this body is only provable with a
 * real key.
 *
 *   gemini-api  POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent   header x-goog-api-key
 *   vertex      POST https://aiplatform.googleapis.com/v1/projects/<p>/locations/<l>/publishers/google/models/<model>:generateContent   Bearer
 *
 * Every failure (network, status, safety block, empty answer, cut-off, bad JSON) is ONE error type, AiError, with a kind and no upstream
 * text. The key, the token and the prompt are never logged. The base URLs are parameters only so tests can point the adapter at a local fake.
 */
import { aiConfig, type AiConfig, type Usage } from './config';
import { AiError } from './errors';
import { accessToken, parseServiceAccount } from './google-auth';

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GenerateArgs {
  system: string;
  parts: Part[];
  /** JSON Schema of the answer (the subset Google supports). */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs?: number;
  /** What the fake model answers when AI_MOCK is on (tests and demos). The caller owns it, so the adapter knows no task. */
  mock?: () => unknown;
}

export interface GeminiDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Tests only. */
  geminiBase?: string;
  vertexBase?: (location: string) => string;
  tokenUrl?: string;
  now?: () => number;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const vertexHost = (location: string): string => `https://${location === 'global' ? '' : `${location}-`}aiplatform.googleapis.com`;
const PROJECT_RE = /^[a-z][a-z0-9-]{4,60}$/;
const LOCATION_RE = /^[a-z0-9-]{3,30}$/;

export function requestBody(a: GenerateArgs, plain = false): Record<string, unknown> {
  const hasImage = a.parts.some((p) => 'inlineData' in p);
  return {
    systemInstruction: { parts: [{ text: a.system }] },
    contents: [{ role: 'user', parts: a.parts }],
    generationConfig: {
      maxOutputTokens: a.maxOutputTokens,
      responseMimeType: 'application/json',
      responseJsonSchema: a.schema,
      // The two tuning fields are the only ones not proven against the live service. `plain` leaves them out.
      ...(plain ? {} : { thinkingConfig: { thinkingLevel: 'MINIMAL' }, ...(hasImage ? { mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' } : {}) }),
    },
  };
}

async function endpoint(c: AiConfig, d: GeminiDeps): Promise<{ url: string; headers: Record<string, string> }> {
  const headers = { 'content-type': 'application/json' } as Record<string, string>;
  if (c.provider === 'vertex') {
    if (!c.serviceAccountRaw || !c.project || !PROJECT_RE.test(c.project) || !LOCATION_RE.test(c.location)) throw new AiError('unconfigured');
    headers.authorization = `Bearer ${await accessToken(parseServiceAccount(c.serviceAccountRaw), { fetch: d.fetch, tokenUrl: d.tokenUrl, now: d.now })}`;
    const base = d.vertexBase?.(c.location) ?? vertexHost(c.location);
    return { url: `${base}/v1/projects/${c.project}/locations/${c.location}/publishers/google/models/${c.model}:generateContent`, headers };
  }
  if (!c.apiKey) throw new AiError('unconfigured');
  headers['x-goog-api-key'] = c.apiKey;
  return { url: `${d.geminiBase ?? GEMINI_BASE}/v1beta/models/${c.model}:generateContent`, headers };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

const TOTAL_MS = 20_000;
const MIN_RETRY_MS = 3_000;

export async function generateJson(a: GenerateArgs, d: GeminiDeps = {}): Promise<{ json: unknown; usage: Usage; model: string; provider: AiConfig['provider'] | 'mock' }> {
  const c = aiConfig(d.env ?? process.env);
  if (c.mock) {
    if (!a.mock) throw new AiError('unconfigured');
    return { json: a.mock(), usage: { inputTokens: 1500, outputTokens: 300, thinkingTokens: 0 }, model: c.model, provider: 'mock' };
  }
  // One deadline for the whole call (token fetch, first try and the retry), kept under the route's maxDuration of 30 s so a slow 400 cannot outlive the function and strand a debited credit.
  const deadline = Date.now() + (a.timeoutMs ?? TOTAL_MS);
  const left = (): number => deadline - Date.now();
  const { url, headers } = await endpoint(c, d);
  const post = async (plain: boolean): Promise<Response> => {
    const ms = left();
    if (ms <= 0) throw new AiError('timeout');
    try {
      return await (d.fetch ?? fetch)(url, { method: 'POST', headers, body: JSON.stringify(requestBody(a, plain)), signal: AbortSignal.timeout(ms) });
    } catch (e) {
      throw new AiError(e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network');
    }
  };
  let res = await post(false);
  // A 400 is not billed. If Google refuses a tuning field of the body, ask once more without it, so a wrong enum spelling cannot silently turn every draft into a template. Only while at least MIN_RETRY_MS of the deadline is left.
  if (res.status === 400 && left() >= MIN_RETRY_MS) res = await post(true);
  if (!res.ok) throw new AiError('http', res.status);
  const body = (await res.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: unknown; thought?: unknown }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown };
  } | null;
  if (!body) throw new AiError('empty');
  const usage: Usage = { inputTokens: num(body.usageMetadata?.promptTokenCount), outputTokens: num(body.usageMetadata?.candidatesTokenCount), thinkingTokens: num(body.usageMetadata?.thoughtsTokenCount) };
  const fail = (kind: ConstructorParameters<typeof AiError>[0]): never => { throw Object.assign(new AiError(kind), { usage }); };
  if (body.promptFeedback?.blockReason) return fail('blocked');
  const cand = body.candidates?.[0];
  if (!cand) return fail('empty');
  if (cand.finishReason === 'MAX_TOKENS') return fail('truncated');
  if (cand.finishReason && cand.finishReason !== 'STOP') return fail('blocked');
  const text = (cand.content?.parts ?? []).filter((p) => p.thought !== true && typeof p.text === 'string').map((p) => p.text as string).join('');
  if (!text) return fail('empty');
  let json: unknown;
  try { json = JSON.parse(text); } catch { return fail('schema'); }
  return { json, usage, model: c.model, provider: c.provider };
}

/** The usage a failed call may still have carried (a blocked or cut-off answer is billed), or null. */
export const usageOf = (e: unknown): Usage | null => (e instanceof AiError ? ((e as AiError & { usage?: Usage }).usage ?? null) : null);
