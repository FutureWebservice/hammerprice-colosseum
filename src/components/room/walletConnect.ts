/**
 * When the wallet picker asks the wallet to connect by itself (K15).
 *
 * The picker selects the wallet the person clicked and then, for a provider that does not auto-connect, calls `connect()` once. It used to
 * call it again every time `connecting` fell back to false while the wallet was still not connected, so a person who rejected the
 * Phantom popup was asked again at once, in a loop. Now one click is one attempt: the attempt is used up as soon as `connect()` was
 * called or the provider was seen connecting, and only a new click (a new attempt number) allows the next one.
 */
export interface AutoConnectState {
  /** The wallet the person clicked, or null before any click. */
  picked: string | null;
  /** The wallet the provider has selected right now. */
  selected: string | null;
  connected: boolean;
  connecting: boolean;
  /** Counts clicks on a wallet button. */
  attempt: number;
  /** The attempt number that already used its one connect. */
  used: number;
}

export type AutoConnectStep = 'wait' | 'connect' | 'consumed';

/**
 * 'connect': call connect() now and mark the attempt used. 'consumed': the provider is already connecting by itself, mark the attempt used
 * without calling. 'wait': do nothing (nothing clicked, wrong wallet selected yet, already connected, or the attempt is used up).
 */
export function autoConnectStep(s: AutoConnectState): AutoConnectStep {
  if (!s.picked || s.attempt === s.used || s.selected !== s.picked || s.connected) return 'wait';
  return s.connecting ? 'consumed' : 'connect';
}

export interface AfterPickState {
  /** The person clicked a wallet to connect it for a sign-in, and that wish is still open. */
  wanted: boolean;
  /** That wallet is connected and its existing session has been looked up (so `anonymous` is an answer, not "not asked yet"). */
  looked: boolean;
  /** The lookup found no session: the wallet has to sign. */
  anonymous: boolean;
  /** A phone: the wallet app takes over the page, so the signature waits for a fresh tap on Sign in (as since 3741e69). */
  mobile: boolean;
}

export type AfterPickStep = 'wait' | 'sign' | 'drop';

/**
 * After a wallet was picked and connected, go straight on into the sign-in signature instead of asking for a second click (Connect, then Sign in).
 * Only for a wallet the person just clicked: one the adapter restored by itself (autoConnect) never signs without a click.
 * 'sign': ask the wallet to sign now. 'drop': forget the wish without signing (a phone, or a session exists already). 'wait': not connected or not looked up yet.
 */
export function afterPick(s: AfterPickState): AfterPickStep {
  if (!s.wanted || !s.looked) return 'wait';
  return s.anonymous && !s.mobile ? 'sign' : 'drop';
}
