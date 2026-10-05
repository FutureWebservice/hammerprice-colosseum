/**
 * The room assistant (WP6b). A question comes in, a FAQ key comes out of `classify` (or the keyword search), and the answer is the fixed
 * FAQ text for that key in the asker's language: the server never returns model text. Advice questions are answered with the fixed
 * "no advice" text before any model call. No history, no stored question, one call per question.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { AiAskRequest as RequestSchema, AiAskResponse as ResponseSchema, Cluster } from '@/contracts';
import { classify, type ClassifyDeps } from './classify';
import { faqByKey, faqFor, fixedText } from './faq';
import { ADVICE_RE } from './keyword';

type Request = z.infer<typeof RequestSchema>;
export type AskResponse = z.infer<typeof ResponseSchema>;

export async function ask(req: Request, who: { profileId: string | null; cluster: Cluster }, deps: ClassifyDeps): Promise<AskResponse> {
  const { question, locale } = req;
  const entries = faqFor(who.cluster);
  const answer = (faqKey: string | null, text: string, source: 'ai' | 'keyword'): AskResponse => ({ answer: text, faqKey, source, label: source === 'ai' ? 'ai' : 'faq' });

  if (ADVICE_RE.test(question)) return answer('no_advice', fixedText('no_advice', locale), 'keyword');
  const c = await classify(question, locale, entries, who.profileId, randomUUID(), deps);
  if (c.faqKey === 'no_advice') return answer('no_advice', fixedText('no_advice', locale), c.source);
  const entry = c.faqKey ? faqByKey(c.faqKey, who.cluster) : undefined;
  if (!entry) return answer(null, fixedText('cannot', locale), c.source);
  return answer(entry.key, entry.a[locale], c.source);
}
