/**
 * Root layout.
 *
 * The real document (<html>, <body>, fonts, providers, i18n) lives in [locale]/layout.tsx, which
 * sets `lang` per locale. This root only passes children through: rendering <html> here as well
 * produced a nested <html><body><html>, so every German page kept `lang="en"`. Routes outside the
 * locale tree (/hp redirects, the metadata routes) render no document of their own.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
