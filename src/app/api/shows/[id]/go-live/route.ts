import { showAction } from '@/app/api/auctions/_shared/lifecycle';
import { auctionService } from '@/app/api/auctions/_shared/deps';

/** Go live now: every lot must be ready, the first lot opens right away. */
export const POST = showAction((id, actor) => auctionService().startShow(id, actor));
