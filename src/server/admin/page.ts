/**
 * What an admin page calls first: the same wallet check as the API, answering 404 (notFound) to everyone else, then the section's data.
 * Pages and layout both call it; a layout is not re-rendered on client navigation, so a page may never rely on the layout's check.
 */
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { adminFrom, pageRequest, type Admin } from './access';
import { loadSection, type Section, type SectionKey } from './data';

export async function requireAdminPage(): Promise<Admin> {
  const admin = await adminFrom(pageRequest((await cookies()).toString()));
  if (!admin) notFound();
  return admin;
}

export interface AdminPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string; q?: string; tab?: string }>;
}

export async function adminPage(key: SectionKey, props: AdminPageProps): Promise<{ data: Section; locale: string }> {
  await requireAdminPage();
  const [{ locale }, sp] = await Promise.all([props.params, props.searchParams]);
  return { data: await loadSection(key, { page: Number(sp.page ?? 1), q: sp.q ?? '', tab: sp.tab, locale }), locale };
}
