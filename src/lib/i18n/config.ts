/**
 * Locales and message namespaces, declared once. Pure: no next-intl import, so middleware,
 * site-routes and tests can use it.
 *
 * Adding a namespace means adding its name here and a JSON file per locale under src/locales.
 * Each file has one owner; everyone else only fills JSON.
 */
export const locales = ['en', 'de'] as const;
export type Locale = (typeof locales)[number];

// Default language (fallback)
export const defaultLocale = 'en' as const;

export const isLocale = (v: unknown): v is Locale => (locales as readonly unknown[]).includes(v);

/** Every namespace the layout sends to the client provider. Empty files are fine until their owner fills them. */
export const NAMESPACES = [
  'common', 'nav', 'footer', 'legal', 'landing', 'rooms', 'room', 'sell', 'account', 'settlement',
  // Optional features and their helpers: each file starts as {} and is filled by exactly one owner.
  'vrf', 'timed', 'video', 'ai', 'chat', 'packs', 'telegram', 'tour', 'glossary', 'features', 'network',
] as const;
export type Namespace = (typeof NAMESPACES)[number];
