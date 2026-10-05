import { adminRoute, auditAdmin } from '@/server/admin/access';
import { waitlistCsv } from '@/server/admin/data';

/** The waiting list as a CSV download. Reading it is audited (it is the one place the addresses leave the panel in bulk). */
export const GET = adminRoute(async (admin) => {
  const csv = await waitlistCsv();
  await auditAdmin(admin, 'waitlist.export', 'waitlist');
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="waitlist.csv"', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
});
