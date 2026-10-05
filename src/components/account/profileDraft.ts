/**
 * The profile form as pure functions (no React, no fetch): what the inputs hold, what changed, and what to send. The server checks and cleans every
 * value again (src/server/profile/rules.ts); this only decides which fields go out and keeps an unchanged form from sending anything.
 * The picture is not part of the draft: it is uploaded as a file of its own (see `checkPicked`).
 */
import { AVATAR_MAX_BYTES, AVATAR_TYPES, type ProfileUpdateRequest, type ProfileView } from '@/contracts/profile';

export interface ProfileDraft { username: string; displayName: string; bio: string }

export const toDraft = (p: ProfileView | null): ProfileDraft => ({ username: p?.username ?? '', displayName: p?.displayName ?? '', bio: p?.bio ?? '' });

const same = (saved: string | null, typed: string): boolean => (saved ?? '').trim() === typed.trim();

/** Only the fields that differ from what is saved; an emptied field becomes `null` (cleared). Null when nothing changed. */
export function buildPatch(saved: ProfileView | null, d: ProfileDraft): ProfileUpdateRequest | null {
  const patch: ProfileUpdateRequest = {};
  if (!same(saved?.username ?? null, d.username)) patch.username = d.username.trim() === '' ? null : d.username.trim();
  if (!same(saved?.displayName ?? null, d.displayName)) patch.displayName = d.displayName.trim() === '' ? null : d.displayName;
  if (!same(saved?.bio ?? null, d.bio)) patch.bio = d.bio.trim() === '' ? null : d.bio;
  return Object.keys(patch).length === 0 ? null : patch;
}

/** The message key under account.profile.rules for a refused field, falling back to the generic one. */
export const RULE_KEYS = [
  'too_short', 'too_long', 'characters', 'link', 'contact_data', 'reserved', 'avatar_https', 'avatar_host', 'avatar_invalid',
  'taken', 'profane', 'avatar_type', 'avatar_size', 'avatar_empty',
] as const;
export const ruleKey = (rule: string | undefined): string => (rule && (RULE_KEYS as readonly string[]).includes(rule) ? `profile.rules.${rule}` : 'profile.rules.generic');

/** A first look at a chosen file before anything is sent (the server decides again from the bytes). */
export function checkPicked(file: { type: string; size: number }): 'avatar_empty' | 'avatar_size' | 'avatar_type' | null {
  if (file.size === 0) return 'avatar_empty';
  if (file.size > AVATAR_MAX_BYTES) return 'avatar_size';
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) return 'avatar_type';
  return null;
}
