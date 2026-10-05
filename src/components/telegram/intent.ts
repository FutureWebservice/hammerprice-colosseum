/**
 * "Take me to the Telegram step": the one URL every link to the Telegram settings uses, and the code that acts on it.
 * `?telegram=open` is the intent; a bare `#telegram` still works as a fallback for old links. Pure and DOM-light so the bot (server) and the panel (client)
 * share one definition and tests can run it against a fake element.
 */
export const TELEGRAM_INTENT_PARAM = 'telegram';
export const TELEGRAM_INTENT_VALUE = 'open';
export const TELEGRAM_ANCHOR = 'telegram';

/** The path (no host) of the account page's Telegram step, without the locale prefix. */
export const TELEGRAM_ACCOUNT_PATH = `/account?${TELEGRAM_INTENT_PARAM}=${TELEGRAM_INTENT_VALUE}#${TELEGRAM_ANCHOR}`;

/** True when the URL asks for the Telegram step: `?telegram=open`, or the legacy `#telegram`. */
export function wantsTelegram(search: string, hash: string): boolean {
  return new URLSearchParams(search).get(TELEGRAM_INTENT_PARAM) === TELEGRAM_INTENT_VALUE || hash.replace(/^#/, '') === TELEGRAM_ANCHOR;
}

/** The URL without the intent parameter (so a reload does not replay it); the hash stays. */
export function withoutIntent(path: string, search: string, hash: string): string {
  const p = new URLSearchParams(search);
  p.delete(TELEGRAM_INTENT_PARAM);
  const q = p.toString();
  return `${path}${q ? `?${q}` : ''}${hash}`;
}

/** The slice of an element this needs; HTMLElement satisfies it. */
export interface IntentEl {
  scrollIntoView(o: { behavior: 'auto' | 'smooth'; block: 'start' }): void;
  focus(o: { preventScroll: boolean }): void;
  querySelector(sel: string): IntentEl | null;
  classList: { add(c: string): void; remove(c: string): void };
}

export const FLASH_CLASS = 'tg--flash';
export const FLASH_MS = 2400;

/**
 * Scrolls the section into view, puts keyboard focus on the one action that matters (Open Telegram while a link is open, Connect while not linked,
 * the section itself when linked: its switches and Disconnect are right below) and highlights the section for a moment.
 * Reduced motion: no smooth scroll, and the highlight is a static outline (see telegram.css). Returns the cleanup that removes the highlight.
 */
export function applyTelegramIntent(root: IntentEl, o: { linked: boolean; reduceMotion: boolean; setTimer?: (f: () => void, ms: number) => unknown }): () => void {
  root.scrollIntoView({ behavior: o.reduceMotion ? 'auto' : 'smooth', block: 'start' });
  const target = o.linked ? root : root.querySelector('[data-testid="telegram-open"]') ?? root.querySelector('[data-testid="telegram-connect"]') ?? root;
  target.focus({ preventScroll: true });
  root.classList.add(FLASH_CLASS);
  const off = () => root.classList.remove(FLASH_CLASS);
  (o.setTimer ?? setTimeout)(off, FLASH_MS);
  return off;
}
