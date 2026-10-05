'use client';

/**
 * The parts of the room that are not on screen when it opens, loaded when the room first renders them (or, for the chat and the assistant, right after the
 * room has painted). Same components, same props; AuctionRoom imports them from here.
 *
 * - PayModal: the settlement round. It brings the Solana transaction code (web3.js, the settlement validator), about 300 kB of script before compression,
 *   which a visitor who only watches never needs.
 * - GetReadySheet: opens from the bid button.
 * - SideChat and Assistant: render nothing until their feature answers that it is on, and the chat panel opens on a click.
 * The room is client-rendered from its first data fetch on, so none of these has server markup to lose (`ssr: false`).
 */
import dynamic from 'next/dynamic';

const loaders = {
  PayModal: () => import('./PayModal'),
  GetReadySheet: () => import('./GetReadySheet'),
  SideChat: () => import('./slots/SideChat'),
  Assistant: () => import('./slots/Assistant'),
};

export const PayModal = dynamic(loaders.PayModal, { ssr: false });
export const GetReadySheet = dynamic(loaders.GetReadySheet, { ssr: false });
export const SideChat = dynamic(loaders.SideChat, { ssr: false });
export const Assistant = dynamic(loaders.Assistant, { ssr: false });

// Once the room has loaded and shown its first data, fetch the rest quietly, so the first click on "bid" or "chat" finds the code already there. Not before: on a slow
// connection these chunks (the settlement code is the big one) must not compete with the room's own first requests.
if (typeof window !== 'undefined') {
  const prefetch = () => { for (const load of Object.values(loaders)) void load().catch(() => undefined); };
  const later = () => setTimeout(prefetch, 4000);
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });
}
