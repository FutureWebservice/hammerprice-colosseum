'use client';
/**
 * The waiting-list form on the landing page. A client component with no provider: the labels arrive as props from the
 * server component, so the page still works with no wallet and no message context.
 *
 * The request itself is submitWaitlist (./waitlist.ts, testable with a mocked fetch). `website` is the honeypot: a real visitor
 * never sees or fills it, a bot does.
 */
import { useId, useState, type FormEvent } from 'react';
import type { Locale } from '@/lib/i18n/config';
import { submitWaitlist, type WaitlistLabels } from './waitlist';

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'done' } | { kind: 'error'; message: string };

export default function WaitlistForm({ locale, labels, privacyHref }: { locale: Locale; labels: WaitlistLabels; privacyHref: string }) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state.kind === 'sending') return;
    setState({ kind: 'sending' });
    const r = await submitWaitlist({ email, locale, website }, labels);
    setState(r.ok ? { kind: 'done' } : { kind: 'error', message: r.message });
  }

  const inputId = `${id}-email`;
  const msgId = `${id}-msg`;
  return (
    <form className="hp-wl-form" onSubmit={onSubmit} data-testid="waitlist-form">
      <div role="status" aria-live="polite">
        {state.kind === 'done' && <p className="hp-wl-ok" data-testid="waitlist-success">{labels.success}</p>}
      </div>
      {state.kind !== 'done' && (
        <>
          <label className="hp-wl-label" htmlFor={inputId}>{labels.label}</label>
          <div className="hp-wl-row">
            <input
              id={inputId}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              maxLength={254}
              placeholder={labels.placeholder}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={state.kind === 'error'}
              aria-describedby={state.kind === 'error' ? msgId : undefined}
              className="hp-wl-input"
            />
            {/* Honeypot: off-screen, out of the tab order and hidden from assistive technology. */}
            <div className="hp-wl-hp" aria-hidden="true">
              <label>
                Website
                <input name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </label>
            </div>
            <button type="submit" className="scr-cta hp-wl-btn" disabled={state.kind === 'sending'}>
              {state.kind === 'sending' ? labels.sending : labels.submit}
            </button>
          </div>
          {state.kind === 'error' && <p className="hp-wl-err" id={msgId} role="alert" data-testid="waitlist-error">{state.message}</p>}
          <p className="hp-wl-note">
            {labels.privacyBefore}
            <a href={privacyHref}>{labels.privacyLink}</a>
          </p>
        </>
      )}
    </form>
  );
}
