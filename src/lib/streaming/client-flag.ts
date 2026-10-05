/**
 * Whether this deployment has the optional live video switched on, for client components (the wizard checkbox and the manager's switch).
 * next.config.js copies FEATURE_VIDEO into NEXT_PUBLIC_FEATURE_VIDEO at build time. It only decides whether to SHOW the controls: the
 * server checks the real switch and the ops kill switch on every call, so a stale value here can never enable anything.
 */
export const videoFeatureOn = (): boolean => process.env.NEXT_PUBLIC_FEATURE_VIDEO === 'true';
