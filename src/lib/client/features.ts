/**
 * Which optional features have an entry point in the navigation, for client components. next.config.js copies FEATURE_PACKS
 * into NEXT_PUBLIC_FEATURE_PACKS at build time. It only decides whether to SHOW a link: the page and every route check the real
 * switch and the ops kill switch on each request and answer 404 while the feature is off, so a stale value here enables nothing.
 */
export const packsNavOn = (): boolean => process.env.NEXT_PUBLIC_FEATURE_PACKS === 'true';

/** The drawn lot order (FEATURE_VRF, copied into NEXT_PUBLIC_FEATURE_VRF at build time): whether the verify page asks for a show's proof. Off: no request, no 404 in the console. */
export const vrfOn = (): boolean => process.env.NEXT_PUBLIC_FEATURE_VRF === 'true';
