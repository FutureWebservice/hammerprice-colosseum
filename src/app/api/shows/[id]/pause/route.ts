import { showAction } from '@/app/api/auctions/_shared/lifecycle';
import { auctionService } from '@/app/api/auctions/_shared/deps';

/**
 * Pause the room: the seller, or an operator wallet on the house show. Bids are refused until the seller resumes or the
 * pause reaches its 5 minute limit; at most 2 pauses per show, never in the last 10 seconds of a lot.
 */
export const POST = showAction((id, actor) => auctionService().pauseShow(id, actor));
