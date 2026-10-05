/** A stand-in for components/auth/SessionProvider in the AI component tests (no wallet adapter): set `session.status` before rendering. Not a test file. */
export const session: { status: 'loading' | 'anonymous' | 'signing-in' | 'signed-in'; connected: boolean; error: { code: string } | null; signInCalls: number; wallet: string | null } = {
  status: 'anonymous', connected: false, error: null, signInCalls: 0, wallet: null,
};
export const resetSession = (): void => { session.status = 'anonymous'; session.connected = false; session.error = null; session.signInCalls = 0; session.wallet = null; };
const signIn = async (): Promise<void> => { session.signInCalls++; };
export const sessionModule = () => ({
  SessionContext: {},
  useSession: () => ({ status: session.status, me: session.status === 'signed-in' && session.wallet ? { wallet: session.wallet } : null, error: session.error, connected: session.connected, signIn, signOut: async () => {}, refresh: async () => null }),
  useSignIn: () => ({ signIn, pending: session.status === 'signing-in', error: session.error, connected: session.connected, signedIn: session.status === 'signed-in' }),
});
