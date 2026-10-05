import { showAction } from '@/app/api/auctions/_shared/lifecycle';
import { auctionService } from '@/app/api/auctions/_shared/deps';

/** Resume a paused room now: the open lot keeps the time it had left (its deadline moves by the paused time). */
export const POST = showAction((id, actor) => auctionService().resumeShow(id, actor));
