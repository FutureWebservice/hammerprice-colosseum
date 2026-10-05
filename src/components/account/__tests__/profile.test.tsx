/** The profile form: which fields go out, every state it renders, both languages, and the accessibility wiring (labels, errors, live regions). */
import { describe, expect, it } from 'vitest';
import { html, tag, isDisabled } from '@/components/sell/__tests__/harness';
import { ProfileEditorView, type FieldErrors } from '../ProfileEditor';
import { buildPatch, ruleKey, toDraft, RULE_KEYS } from '../profileDraft';
import { PROFILE_REJECT_REASONS, type ProfileView } from '@/contracts/profile';
import enAccount from '@/locales/en/account.json';
import deAccount from '@/locales/de/account.json';

const saved: ProfileView = { id: '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10', username: 'anna_7', displayName: 'Anna', bio: 'Collector', avatarUrl: null, avatar: null, createdAt: '2026-09-01T10:00:00Z', strikes: 0 };
const view = (o: { draft?: ReturnType<typeof toDraft>; saved?: ProfileView | null; status?: 'loading' | 'ready' | 'saving' | 'saved' | 'error'; errors?: FieldErrors; locale?: 'en' | 'de' } = {}) =>
  html(<ProfileEditorView draft={o.draft ?? toDraft(o.saved === undefined ? saved : o.saved)} saved={o.saved === undefined ? saved : o.saved} status={o.status ?? 'ready'} errors={o.errors ?? {}} onChange={() => {}} onSubmit={() => {}} />, o.locale ?? 'en');

describe('buildPatch', () => {
  it('sends nothing when nothing changed (also when only white space differs)', () => {
    expect(buildPatch(saved, toDraft(saved))).toBeNull();
    expect(buildPatch(saved, { ...toDraft(saved), displayName: '  Anna  ' })).toBeNull();
    expect(buildPatch(null, toDraft(null))).toBeNull();
  });
  it('sends only the fields that changed; an emptied field is null (cleared)', () => {
    expect(buildPatch(saved, { ...toDraft(saved), bio: 'Dealer' })).toEqual({ bio: 'Dealer' });
    expect(buildPatch(saved, { username: '', displayName: '', bio: 'Collector' })).toEqual({ username: null, displayName: null });
    expect(buildPatch(null, { username: 'Anna_1', displayName: 'Anna', bio: '' })).toEqual({ username: 'Anna_1', displayName: 'Anna' });
    expect(buildPatch(saved, { username: 'anna_7', displayName: '   ', bio: 'Collector' })).toEqual({ displayName: null });
  });
  it('has a message for every rule the server can name', () => {
    expect([...RULE_KEYS].sort()).toEqual([...PROFILE_REJECT_REASONS].sort());
    for (const r of PROFILE_REJECT_REASONS) for (const msgs of [enAccount, deAccount]) expect((msgs.profile.rules as Record<string, string>)[r], r).toBeTypeOf('string');
    expect(ruleKey('link')).toBe('profile.rules.link');
    expect(ruleKey('something_new')).toBe('profile.rules.generic');
    expect(ruleKey(undefined)).toBe('profile.rules.generic');
  });
});

describe('ProfileEditorView', () => {
  it('shows the three fields with their labels and hints, and says where each one appears', () => {
    const m = view();
    for (const id of ['profile-editor', 'profile-username', 'profile-name', 'profile-bio', 'profile-save', 'profile-where']) expect(tag(m, id), id).not.toBeNull();
    expect(m).not.toContain('profile-avatar'); // the picture is uploaded as a file now, not typed as an address
    expect(m).toContain('Edit profile');
    expect(m).toContain('Username');
    expect(m).toContain('Display name');
    expect(m).toContain('About you');
    expect(m).toContain('value="anna_7"');
    expect(m).toContain('value="Anna"');
    expect(m).toContain('3 to 24 characters: letters, digits and underscores');
    expect(m).toContain('The chat shows your display name, if you set one, and always your bidder number.');
    expect(m).toContain('Bidder 7');
    expect(m).toContain('Bids and the bid log always show your bidding number only.');
    expect(m).toContain('151 characters left (up to 160)');
  });

  it('every input has a real label and a description; the save button is disabled until something changes', () => {
    const m = view();
    for (const [id, hint] of [['profile-username', 'profile-username-hint'], ['profile-name', 'profile-name-hint'], ['profile-bio', 'profile-bio-hint']]) {
      expect(m).toContain(`for="${id}"`);
      expect(tag(m, id)).toContain(`id="${id}"`);
      expect(tag(m, id)).toContain(`aria-describedby="${hint}"`);
      expect(m).toContain(`id="${hint}"`);
    }
    expect(isDisabled(m, 'profile-save')).toBe(true);
    expect(isDisabled(view({ draft: { ...toDraft(saved), displayName: 'Anna B' } }), 'profile-save')).toBe(false);
    expect(isDisabled(view({ draft: { ...toDraft(saved), username: 'anna_8' } }), 'profile-save')).toBe(false);
  });

  it('shows a refused username next to its field (taken), tied to the input', () => {
    const m = view({ errors: { username: 'That username is already taken. Please choose another.' } });
    expect(tag(m, 'profile-username-error')).toContain('role="alert"');
    expect(tag(m, 'profile-username')).toContain('aria-invalid="true"');
    expect(tag(m, 'profile-username')).toContain('aria-describedby="profile-username-hint profile-username-err"');
    expect(m).toContain('already taken');
  });

  it('while loading the inputs and the button are disabled and a status says so; while saving the button says so', () => {
    const loading = view({ status: 'loading', saved: null });
    expect(isDisabled(loading, 'profile-name')).toBe(true);
    expect(isDisabled(loading, 'profile-save')).toBe(true);
    expect(loading).toContain('role="status"');
    expect(loading).toContain('Loading your profile...');
    const saving = view({ status: 'saving', draft: { ...toDraft(saved), bio: 'New' } });
    expect(isDisabled(saving, 'profile-save')).toBe(true);
    expect(saving).toContain('Saving...');
  });

  it('shows the server\'s refusal next to its field, as an alert, and marks the input invalid and described by it', () => {
    const m = view({ errors: { displayName: 'Links are not allowed here.' } });
    expect(tag(m, 'profile-name-error')).toContain('role="alert"');
    expect(m).toContain('Links are not allowed here.');
    expect(tag(m, 'profile-name')).toContain('aria-invalid="true"');
    expect(tag(m, 'profile-name')).toContain('aria-describedby="profile-name-hint profile-name-err"');
    expect(tag(m, 'profile-bio')).not.toContain('aria-invalid');
    const form = view({ errors: { form: 'We could not save your profile. Try again in a moment.' } });
    expect(tag(form, 'profile-form-error')).toContain('role="alert"');
  });

  it('confirms a save in a live status region', () => {
    const m = view({ status: 'saved' });
    expect(tag(m, 'profile-saved')).toContain('role="status"');
    expect(m).toContain('Your profile was saved.');
    expect(view({ status: 'ready' })).not.toContain('profile-saved');
  });

  it('counts the bio against 160 and warns in the error colour once it is over', () => {
    const over = view({ draft: { ...toDraft(saved), bio: 'x'.repeat(170) } });
    expect(over).toContain('-10 characters left (up to 160)');
    expect(over).toMatch(/class="sl-err"[^>]*data-testid="profile-bio-count"/);
  });

  it('speaks German in the same structure', () => {
    const m = view({ locale: 'de', errors: { username: 'Dieser Benutzername ist schon vergeben. Bitte wählen Sie einen anderen.' } });
    for (const w of ['Profil bearbeiten', 'Benutzername', 'Anzeigename', 'Über Sie', 'Profil speichern', 'Bieter 7', 'Gebote und das Gebotsprotokoll zeigen immer nur Ihre Bieternummer.']) expect(m, w).toContain(w);
    expect(m).not.toContain('Edit profile');
    expect(m).not.toContain('Display name');
  });

  it('has no em dash and the same placeholders in both languages', () => {
    const flat = (o: Record<string, unknown>, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
    expect(flat(enAccount.profile).sort()).toEqual(flat(deAccount.profile).sort());
    const vars = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\s*[,}]/g)].map((x) => x[1]))].sort();
    const get = (o: unknown, key: string) => key.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)[k], o) as string;
    for (const k of flat(enAccount.profile)) {
      expect(get(enAccount.profile, k)).not.toContain('\u2014');
      expect(vars(get(deAccount.profile, k)), k).toEqual(vars(get(enAccount.profile, k)));
    }
  });
});
