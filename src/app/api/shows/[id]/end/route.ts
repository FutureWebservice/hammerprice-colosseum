import { showAction } from '@/app/api/auctions/_shared/lifecycle';
import { auctionService } from '@/app/api/auctions/_shared/deps';

/** End the show: no new lot opens, a lot already on the block runs to its closing time. */
export const POST = showAction((id, actor) => auctionService().endShow(id, actor));
