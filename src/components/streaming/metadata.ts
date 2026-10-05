import { getTranslations } from 'next-intl/server';

/** The page metadata of the broadcast page (kept here so the sell page directory carries no message keys of the video namespace). */
export async function broadcastMetadata(locale: string) {
  const t = await getTranslations({ locale, namespace: 'video' });
  return { title: t('broadcast.meta'), robots: { index: false } };
}
