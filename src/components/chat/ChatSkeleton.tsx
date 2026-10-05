'use client';

import { useTranslations } from 'next-intl';

/** Grey bars in the shape of the panel, shown while the panel's code loads (SideChat), so the sidebar is never an empty dark area. */
export default function ChatSkeleton() {
  const t = useTranslations('chat');
  return (
    <div className="hc-skel" data-testid="chat-skeleton" role="status" aria-live="polite" aria-label={t('panel.loading')}>
      <div className="hc-skel-bar" /><div className="hc-skel-bar is-short" /><div className="hc-skel-bar" /><div className="hc-skel-bar is-short" />
    </div>
  );
}
