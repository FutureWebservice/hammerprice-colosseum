/**
 * Which message namespaces each part of the site sends to the browser.
 *
 * The locale layout used to hand every namespace to the client provider, so every page carried all of them (about 148 kB of text in the page, 44 kB
 * after compression, whatever the page was). Now the layout sends only what the page chrome reads (CHROME), and each route group wraps its pages in a
 * provider with the namespaces its client components use (ROUTE_NAMESPACES, applied by the layout.tsx of that route: see PageMessages.tsx).
 *
 * A name can be a whole namespace ('nav') or a path inside one ('room.wallet'). src/lib/i18n/__tests__/route-namespaces.test.ts reads the import graph of
 * every route and fails when a client component asks for a namespace that is not listed here, so a new `useTranslations('x')` cannot ship a page with
 * missing texts. Server components are not affected: they read the texts straight from the request config.
 *
 * Pure: no next-intl import, so tests and scripts can use it.
 */

type Messages = Record<string, unknown>;

/** The page chrome: header (nav, the session control, the Help menu, the wallet sheet it opens), footer, skip link, error and 404 panels. */
export const CHROME = ['common.states', 'nav', 'footer', 'room.a11y', 'room.wallet', 'account.session', 'tour.help'] as const;

export const ROUTE_NAMESPACES = {
  about: ['glossary'],
  account: ['account', 'nav', 'room', 'sell', 'telegram', 'tour'],
  // 'account.session' is the sign-in notice (components/auth/SignInNotice.tsx), shown wherever a page asks for a sign-in.
  ai: ['ai', 'account.session'],
  packs: ['account.session', 'nav', 'packs', 'room', 'rooms'],
  room: ['account.session', 'ai', 'chat', 'footer', 'glossary', 'room', 'rooms', 'settlement', 'timed', 'tour', 'video', 'vrf'],
  rooms: ['rooms', 'timed'],
  sell: ['account.session', 'ai', 'glossary', 'nav', 'packs', 'room', 'sell', 'timed', 'tour', 'video'],
  verify: ['glossary', 'packs', 'rooms', 'settlement', 'vrf'],
} as const satisfies Record<string, readonly string[]>;

export type RouteGroup = keyof typeof ROUTE_NAMESPACES;

/** The parts of `all` named by `paths` ('ns' or 'ns.sub.path'); a name that does not exist is skipped. */
export function pickMessages<T extends Messages>(all: T, paths: readonly string[]): Messages {
  const out: Messages = {};
  for (const p of paths) {
    const parts = p.split('.');
    let src: unknown = all;
    for (const k of parts) src = typeof src === 'object' && src !== null ? (src as Messages)[k] : undefined;
    if (src === undefined) continue;
    let dst = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const held = dst[parts[i]];
      dst = (typeof held === 'object' && held !== null ? held : (dst[parts[i]] = {})) as Messages;
    }
    dst[parts[parts.length - 1]] = src;
  }
  return out;
}
