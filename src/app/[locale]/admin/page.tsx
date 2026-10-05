import AdminSection from '@/components/admin/AdminSection';
import { adminPage, type AdminPageProps } from '@/server/admin/page';

export const dynamic = 'force-dynamic';

export default async function Page(props: AdminPageProps) {
  const { data, locale } = await adminPage('overview', props);
  return <AdminSection data={data} locale={locale} />;
}
