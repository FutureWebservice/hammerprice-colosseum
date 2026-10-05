import { z } from 'zod';
import { json } from '@/lib/http/respond';
import { readBody } from '@/lib/auth/route';
import { adminRoute } from '@/server/admin/access';
import { cancelShow } from '@/server/admin/actions';

/** Cancel a show that has not started: { id }. */
export const POST = adminRoute(async (admin, req: Request) => {
  const { id } = await readBody(req, z.object({ id: z.string().max(64) }));
  await cancelShow(admin, id);
  return json({ ok: true });
}, { write: true });
