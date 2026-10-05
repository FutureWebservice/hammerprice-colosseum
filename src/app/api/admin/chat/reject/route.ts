import { z } from 'zod';
import { json } from '@/lib/http/respond';
import { readBody } from '@/lib/auth/route';
import { adminRoute } from '@/server/admin/access';
import { rejectChatMessage } from '@/server/admin/actions';

/** Reject (hide) one chat message: { id }. */
export const POST = adminRoute(async (admin, req: Request) => {
  const { id } = await readBody(req, z.object({ id: z.string().max(64) }));
  await rejectChatMessage(admin, id);
  return json({ ok: true });
}, { write: true });
