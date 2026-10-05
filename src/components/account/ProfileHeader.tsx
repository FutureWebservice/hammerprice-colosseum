'use client';

/**
 * The top of the profile page: picture, username, display name, short text, the wallet address (copyable, with an explorer link), member since and
 * strikes. `ProfileHeaderView` is pure (props in, markup out) so every state renders without a network; `ProfileHeader` adds the copy button.
 */
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { ProfileView } from '@/contracts/profile';
import { addressUrl } from '@/components/sell/chain-links';
import { avatarSrc } from './api';
import { formatDay, identicon } from './format';
import type { Load } from './useProfileData';

/** The generated picture: decorative (the name beside it says who it is). */
export function Identicon({ seed, size = 80 }: { seed: string; size?: number }) {
  const { hue, cells } = identicon(seed);
  const fg = `hsl(${hue} 55% 62%)`;
  return (
    <svg className="ac-avatar ac-identicon" width={size} height={size} viewBox="0 0 5 5" aria-hidden="true" focusable="false" data-testid="identicon" shapeRendering="crispEdges">
      <rect width="5" height="5" fill={`hsl(${hue} 30% 16%)`} />
      {cells.flatMap((row, y) => row.map((on, x) => (on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={fg} /> : null)))}
    </svg>
  );
}

/** The uploaded picture, else the old picture address, else the identicon. */
export function Avatar({ profile, size = 80 }: { profile: Pick<ProfileView, 'id' | 'avatar' | 'avatarUrl'>; size?: number }) {
  if (profile.avatar) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="ac-avatar" src={avatarSrc(profile.id, profile.avatar.version)} alt="" width={size} height={size} decoding="async" data-testid="avatar-image" />;
  }
  if (profile.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="ac-avatar" src={profile.avatarUrl} alt="" width={size} height={size} referrerPolicy="no-referrer" decoding="async" data-testid="avatar-image" />;
  }
  return <Identicon seed={profile.id} size={size} />;
}

export type CopyState = 'idle' | 'copied' | 'failed';

export function ProfileHeaderView({
  profile, wallet, copy, onCopy,
}: { profile: Load<ProfileView>; wallet: string; copy: CopyState; onCopy: () => void }) {
  const t = useTranslations('account');
  const locale = useLocale();
  if (profile.status === 'loading') return <p className="sl-note" role="status" data-testid="header-loading">{t('header.loading')}</p>;
  if (profile.status === 'error') return <p className="sl-warn" role="alert" data-testid="header-error">{t('header.loadError')}</p>;
  const p = profile.data;
  return (
    <section className="ac-head" aria-label={t('tabs.profile')} data-testid="profile-header">
      <Avatar profile={p} />
      <div className="ac-head-body">
        <h2 className="ac-name" data-testid="header-username">{p.username ?? <span className="ac-name--none">{t('header.noName')}</span>}</h2>
        {p.displayName && <p className="ac-display" data-testid="header-display-name">{p.displayName}</p>}
        {p.bio && <p className="ac-bio" data-testid="header-bio">{p.bio}</p>}
        <dl className="ac-facts">
          <div>
            <dt>{t('header.wallet')}</dt>
            <dd>
              <code className="ac-wallet" data-testid="header-wallet" title={wallet}>{wallet}</code>
              <button type="button" className="sl-btn" onClick={onCopy} data-testid="copy-wallet">{t('header.copy')}</button>
              <a href={addressUrl(wallet)} target="_blank" rel="noopener noreferrer" data-testid="wallet-explorer">{t('header.explorer')}</a>
              <span role="status" className={copy === 'failed' ? 'sl-err' : 'sl-ok'} data-testid="copy-status">
                {copy === 'copied' && t('header.copied')}
                {copy === 'failed' && t('header.copyFailed')}
              </span>
            </dd>
          </div>
          <div>
            <dt>{t('header.memberSince')}</dt>
            <dd data-testid="header-member-since">{formatDay(p.createdAt, locale)}</dd>
          </div>
          <div>
            <dt>{t('header.strikes')}</dt>
            <dd data-testid="header-strikes">{t('header.strikesValue', { count: p.strikes })}</dd>
          </div>
        </dl>
        <p className="sl-note">{t('header.strikesNote')}</p>
      </div>
    </section>
  );
}

export default function ProfileHeader({ profile, wallet }: { profile: Load<ProfileView>; wallet: string }) {
  const [copy, setCopy] = useState<CopyState>('idle');
  const onCopy = () => {
    const write = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText(wallet) : undefined;
    if (!write) return setCopy('failed');
    write.then(() => setCopy('copied'), () => setCopy('failed'));
  };
  return <ProfileHeaderView profile={profile} wallet={wallet} copy={copy} onCopy={onCopy} />;
}
