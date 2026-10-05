import Link from 'next/link';
import type { Metadata } from 'next';
import { requireAdminPage } from '@/server/admin/page';
import Logo from '@/components/brand/Logo';

export const metadata: Metadata = { title: 'Admin', robots: { index: false, follow: false, nocache: true } };
export const dynamic = 'force-dynamic';

const NAV: [string, string][] = [['', 'Overview'], ['/rooms', 'Rooms'], ['/lots', 'Auctions and lots'], ['/history', 'History'], ['/users', 'Users'], ['/cards', 'Cards'], ['/chats', 'Chats'], ['/waitlist', 'Waiting list']];

/** Everyone who is not an admin gets the 404 page here, so not even the navigation shows. Pages check again themselves. */
export default async function AdminLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  await requireAdminPage();
  const { locale } = await params;
  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-8">
      <Link href={`/${locale}`} aria-label="Hammerprice" className="mb-4 flex items-center gap-3"><Logo className="h-7 w-auto" /><span className="text-xs uppercase tracking-[0.16em] text-white/60">Admin</span></Link>
      <nav aria-label="Admin" className="mb-8 flex flex-wrap gap-x-5 gap-y-2 border-b border-white/15 pb-3 text-sm">
        {NAV.map(([path, label]) => <Link key={path} href={`/${locale}/admin${path}`} className="text-white/80 hover:text-white">{label}</Link>)}
      </nav>
      {children}
    </div>
  );
}
