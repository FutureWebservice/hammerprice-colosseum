'use client';

/**
 * The room's frame, shared by the real room and the practice room: the room's status line (the one h1, the live
 * state and, in the practice room, its label), then the banners and the room itself. The site header above it, the
 * skip link before that and the wallet, language and account controls in the header all come from SiteChrome (the
 * same Header as every other page, compact), so there is no second nav and no second wallet button in here. The page
 * is already inside the layout's single <main>, so this renders a plain div.
 */
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { ShowStatus } from '@/components/auction/types';
import type { ShowKind } from '@/contracts/common';
import LegalLinkRow from '@/components/legal/LegalLinkRow';
import NetworkStrip from './NetworkStrip';
import { DemoBadge } from './DemoBadge';
import '@/components/auction/auction.css';
import './room.css';

export default function RoomShell({
  locale, title, status, pill, banners, wallet = false, kind = 'live', demo = false, seller = null, children,
}: {
  locale: string;
  title: string;
  status: ShowStatus | null;
  /** The practice room's label, next to the live state. */
  pill?: ReactNode;
  banners?: ReactNode;
  /** The room settles with a wallet: the strip then also holds the wallet help and the test USDC link. */
  wallet?: boolean;
  /** A timed show says so in the status line instead of the pulsing live dot. Absent or 'live': as before. */
  kind?: ShowKind;
  /** The house (demo) room: wears the DEMO badge next to the title and the live state. */
  demo?: boolean;
  /** The seller's chosen display name (a seller's room, never the house); absent or null: nothing is said. */
  seller?: string | null;
  children: ReactNode;
}) {
  const t = useTranslations('room');
  const tt = useTranslations('timed');
  return (
    <div className="hp ar-room">
      <div className="ar-roomline">
        <h1 className="ar-roomline-title">{title}</h1>
        {status === 'live' && kind === 'timed' ? (
          <span className="ar-status-pill" data-testid="timed-badge">{tt('badge')}</span>
        ) : status === 'live' ? (
          <span className="ar-live"><span className="ar-live-dot" />{t('status.live')}</span>
        ) : status ? (
          <span className="ar-status-pill">{status === 'ended' ? t('status.showEnded') : t('status.scheduled')}</span>
        ) : null}
        {demo && <DemoBadge />}
        {pill}
        {seller && !demo && <span className="ar-roomline-by" data-testid="room-seller">{t('seller.by', { name: seller })}</span>}
      </div>
      <NetworkStrip locale={locale} wallet={wallet} />
      {banners}
      {children}
      <LegalLinkRow className="px-4 py-2" />
    </div>
  );
}
