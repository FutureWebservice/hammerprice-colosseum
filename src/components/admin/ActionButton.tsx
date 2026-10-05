'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const URLS = { 'waitlist.delete': '/api/admin/waitlist/delete', 'chat.reject': '/api/admin/chat/reject', 'show.cancel': '/api/admin/shows/cancel' } as const;

/** One admin write: confirm, POST { id } to the admin API (which checks the wallet again), then reload the table. */
export default function ActionButton({ action, id, label, confirmText }: { action: keyof typeof URLS; id: string; label: string; confirmText: string }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | string>('idle');
  async function run() {
    if (!window.confirm(confirmText)) return;
    setState('busy');
    try {
      const res = await fetch(URLS[action], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        setState(body.reason ?? `Failed (${res.status})`);
        return;
      }
      setState('idle');
      router.refresh();
    } catch {
      setState('Network error');
    }
  }
  return (
    <span>
      <button type="button" onClick={run} disabled={state === 'busy'} className="rounded border border-red-400/50 px-2 py-0.5 text-xs text-red-300 hover:bg-red-400/10 disabled:opacity-50">{label}</button>
      {state !== 'idle' && state !== 'busy' ? <span role="alert" className="ml-2 text-xs text-red-300">{state}</span> : null}
    </span>
  );
}
