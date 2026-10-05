import { getRequestConfig } from 'next-intl/server';
import { routing } from '@/lib/i18n';
import { loadMessages } from '@/lib/i18n/messages';

export default getRequestConfig(async ({ requestLocale }) => {
  // This typically corresponds to the `[locale]` segment
  let locale = await requestLocale;

  // Ensure that a valid locale is used
  if (!locale || !routing.locales.includes(locale as (typeof routing.locales)[number])) {
    locale = routing.defaultLocale;
  }

  return { locale, messages: await loadMessages(locale) };
});
