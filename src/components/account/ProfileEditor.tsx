'use client';

import { useCallback, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AVATAR_TYPES, BIO_MAX, DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, USERNAME_MAX, USERNAME_MIN, type ProfileView } from '@/contracts/profile';
import { formatWait } from '@/components/sell/datetime';
import type { ApiFail } from '@/components/sell/api';
import { deleteAvatar, saveProfile, uploadAvatar } from './api';
import { Avatar } from './ProfileHeader';
import { buildPatch, checkPicked, ruleKey, toDraft, type ProfileDraft } from './profileDraft';
import type { Load } from './useProfileData';

export type EditorStatus = 'loading' | 'ready' | 'saving' | 'saved' | 'error';
export interface FieldErrors { username?: string; displayName?: string; bio?: string; form?: string }

/** The form for loaded data. Pure apart from what the parent passes in, so every state renders (and is tested) without a network. */
export function ProfileEditorView({
  draft, saved, status, errors, onChange, onSubmit,
}: {
  draft: ProfileDraft;
  saved: ProfileView | null;
  status: EditorStatus;
  errors: FieldErrors;
  onChange: (next: ProfileDraft) => void;
  onSubmit: () => void;
}) {
  const t = useTranslations('account');
  const busy = status === 'saving' || status === 'loading';
  const dirty = buildPatch(saved, draft) !== null;
  const bioLeft = BIO_MAX - [...draft.bio].length;
  return (
    <section className="sl-profile" aria-labelledby="profile-heading" data-testid="profile-editor">
      <h2 className="sl-h3" id="profile-heading">{t('profile.title')}</h2>
      <p className="sl-note" id="profile-lede">{t('profile.lede')}</p>
      <form noValidate aria-describedby="profile-lede" onSubmit={(e) => { e.preventDefault(); if (!busy && dirty) onSubmit(); }}>
        <div className="sl-field">
          <label htmlFor="profile-username"><span>{t('profile.username')}</span></label>
          <input
            id="profile-username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={USERNAME_MAX * 2} value={draft.username} disabled={status === 'loading'}
            aria-invalid={errors.username ? true : undefined} aria-describedby={`profile-username-hint${errors.username ? ' profile-username-err' : ''}`}
            data-testid="profile-username" onChange={(e) => onChange({ ...draft, username: e.target.value })}
          />
          <small id="profile-username-hint" className="sl-hint">{t('profile.usernameHint', { min: USERNAME_MIN, max: USERNAME_MAX })}</small>
          {errors.username && <small id="profile-username-err" className="sl-err" role="alert" data-testid="profile-username-error">{errors.username}</small>}
        </div>

        <div className="sl-field">
          <label htmlFor="profile-name"><span>{t('profile.name')}</span></label>
          <input
            id="profile-name" type="text" autoComplete="nickname" maxLength={DISPLAY_NAME_MAX * 2} value={draft.displayName} disabled={status === 'loading'}
            aria-invalid={errors.displayName ? true : undefined} aria-describedby={`profile-name-hint${errors.displayName ? ' profile-name-err' : ''}`}
            data-testid="profile-name" onChange={(e) => onChange({ ...draft, displayName: e.target.value })}
          />
          <small id="profile-name-hint" className="sl-hint">{t('profile.nameHint', { max: DISPLAY_NAME_MAX })}</small>
          {errors.displayName && <small id="profile-name-err" className="sl-err" role="alert" data-testid="profile-name-error">{errors.displayName}</small>}
        </div>

        <div className="sl-field">
          <label htmlFor="profile-bio"><span>{t('profile.bio')}</span></label>
          <textarea
            id="profile-bio" rows={3} maxLength={BIO_MAX * 2} value={draft.bio} disabled={status === 'loading'}
            aria-invalid={errors.bio ? true : undefined} aria-describedby={`profile-bio-hint${errors.bio ? ' profile-bio-err' : ''}`}
            data-testid="profile-bio" onChange={(e) => onChange({ ...draft, bio: e.target.value })}
          />
          <small id="profile-bio-hint" className={bioLeft < 0 ? 'sl-err' : 'sl-hint'} data-testid="profile-bio-count">{t('profile.bioHint', { left: bioLeft, max: BIO_MAX })}</small>
          {errors.bio && <small id="profile-bio-err" className="sl-err" role="alert" data-testid="profile-bio-error">{errors.bio}</small>}
        </div>

        <p className="sl-note" data-testid="profile-where">{t('profile.where')}</p>
        <div className="sl-actions">
          <button type="submit" className="sl-btn sl-btn--primary" data-testid="profile-save" disabled={busy || !dirty}>
            {status === 'saving' ? t('profile.saving') : t('profile.save')}
          </button>
        </div>
        {errors.form && <p className="sl-warn" role="alert" data-testid="profile-form-error">{errors.form}</p>}
        {status === 'saved' && <p className="sl-ok" role="status" data-testid="profile-saved">{t('profile.saved')}</p>}
        {status === 'loading' && <p className="sl-note" role="status">{t('profile.loading')}</p>}
      </form>
    </section>
  );
}

export type AvatarStatus = 'idle' | 'busy' | 'done' | 'removed' | 'error';

/** The picture: the current one (or the generated one), a file chooser and Remove. `message` is the translated outcome, shown in a live region. */
export function AvatarEditorView({
  profile, status, message, onPick, onRemove,
}: { profile: ProfileView; status: AvatarStatus; message: string | null; onPick: (file: File) => void; onRemove: () => void }) {
  const t = useTranslations('account');
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = status === 'busy';
  return (
    <section className="sl-profile ac-avatar-editor" aria-labelledby="avatar-heading" data-testid="avatar-editor">
      <h2 className="sl-h3" id="avatar-heading">{t('avatar.title')}</h2>
      <div className="ac-avatar-row">
        <Avatar profile={profile} size={96} />
        <div>
          <p className="sl-note" id="avatar-hint">{t('avatar.hint')}</p>
          <input
            ref={inputRef} id="avatar-file" className="ac-file" type="file" accept={AVATAR_TYPES.join(',')} disabled={busy} tabIndex={-1} aria-hidden="true" data-testid="avatar-file"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ''; }}
          />
          <div className="sl-actions">
            <button type="button" className="sl-btn sl-btn--primary" disabled={busy} onClick={() => inputRef.current?.click()} aria-describedby="avatar-hint" data-testid="avatar-choose">
              {busy ? t('avatar.uploading') : t('avatar.choose')}
            </button>
            {profile.avatar && <button type="button" className="sl-btn" disabled={busy} onClick={onRemove} data-testid="avatar-remove">{t('avatar.remove')}</button>}
          </div>
          <p role="status" className={status === 'error' ? 'sl-err' : 'sl-ok'} data-testid="avatar-message">{message}</p>
        </div>
      </div>
    </section>
  );
}

/** The user's profile form and picture: saves only what changed, shows the server's refusal next to the field it is about. */
export default function ProfileEditor({ profile, onProfile }: { profile: Load<ProfileView>; onProfile: (p: ProfileView) => void }) {
  const t = useTranslations('account');
  const locale = useLocale();
  const saved = profile.status === 'ready' ? profile.data : null;
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [status, setStatus] = useState<EditorStatus>('ready');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [avatar, setAvatar] = useState<{ status: AvatarStatus; message: string | null }>({ status: 'idle', message: null });

  const wait = useCallback((r: ApiFail) => (r.retryAfterS ? formatWait(r.retryAfterS, locale) : t('profile.later')), [locale, t]);

  const failText = useCallback((r: ApiFail): FieldErrors => {
    const field = r.field;
    if (r.code === 'validation' && (field === 'username' || field === 'displayName' || field === 'bio')) {
      const min = field === 'username' ? USERNAME_MIN : DISPLAY_NAME_MIN;
      const max = field === 'bio' ? BIO_MAX : field === 'username' ? USERNAME_MAX : DISPLAY_NAME_MAX;
      return { [field]: t(ruleKey(r.rule), { min, max }) };
    }
    if (r.code === 'rate_limited') return { form: t('profile.rateLimited', { wait: wait(r) }) };
    if (r.code === 'unauthenticated') return { form: t('profile.signedOut') };
    return { form: t('profile.saveError') };
  }, [t, wait]);

  if (profile.status === 'loading') return <p className="sl-note" role="status">{t('profile.loading')}</p>;
  if (!saved) return <p className="sl-warn" role="alert" data-testid="profile-load-error">{t('profile.loadError')}</p>;

  const current = draft ?? toDraft(saved);
  const submit = async () => {
    const patch = buildPatch(saved, current);
    if (!patch) return;
    setStatus('saving');
    setErrors({});
    const r = await saveProfile(patch);
    if (r.ok) { onProfile(r.data.profile); setDraft(null); setStatus('saved'); } else { setStatus('ready'); setErrors(failText(r)); }
  };

  const avatarFail = (r: ApiFail): string => {
    if (r.code === 'validation' && r.rule === 'avatar_size') return t('avatar.tooBig');
    if (r.code === 'validation' && r.rule === 'avatar_empty') return t('avatar.empty');
    if (r.code === 'validation') return t('avatar.wrongType');
    if (r.code === 'rate_limited') return t('avatar.rateLimited', { wait: wait(r) });
    if (r.code === 'unauthenticated') return t('avatar.signedOut');
    return t('avatar.failed');
  };
  const pick = async (file: File) => {
    const early = checkPicked(file);
    if (early) return setAvatar({ status: 'error', message: t(early === 'avatar_size' ? 'avatar.tooBig' : early === 'avatar_empty' ? 'avatar.empty' : 'avatar.wrongType') });
    setAvatar({ status: 'busy', message: null });
    const r = await uploadAvatar(file);
    if (r.ok) { onProfile(r.data.profile); setAvatar({ status: 'done', message: t('avatar.done') }); } else setAvatar({ status: 'error', message: avatarFail(r) });
  };
  const remove = async () => {
    setAvatar({ status: 'busy', message: null });
    const r = await deleteAvatar();
    if (r.ok) { onProfile(r.data.profile); setAvatar({ status: 'removed', message: t('avatar.removed') }); } else setAvatar({ status: 'error', message: avatarFail(r) });
  };

  return (
    <>
      <AvatarEditorView profile={saved} status={avatar.status} message={avatar.message} onPick={(f) => void pick(f)} onRemove={() => void remove()} />
      <ProfileEditorView
        draft={current} saved={saved} status={status} errors={errors}
        onChange={(d) => { setDraft(d); if (status === 'saved') setStatus('ready'); }}
        onSubmit={() => void submit()}
      />
    </>
  );
}
