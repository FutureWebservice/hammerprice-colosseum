import { showAction } from '@/app/api/auctions/_shared/lifecycle';
import { auctionService } from '@/app/api/auctions/_shared/deps';

/** Cancel a show that has not started. */
export const POST = showAction((id, actor) => auctionService().cancelShow(id, actor));
