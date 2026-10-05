/** A FAQ answer as one chat line: the chat takes at most 200 characters, so the answer is cut at the last sentence that fits (or at a word, with an ellipsis). Pure. */
export const CHAT_MAX = 200;

export function chatLine(answer: string, max = CHAT_MAX): string {
  const t = answer.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence >= 40) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(' ', max - 1);
  return `${cut.slice(0, word > 40 ? word : max - 1).replace(/[ .,;:]+$/, '')}…`;
}
