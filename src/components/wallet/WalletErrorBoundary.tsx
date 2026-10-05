'use client';

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

// The boundary is a class and sits above any translation hook, so it reads the page language itself.
const TEXT = {
  en: { title: 'Wallet error', fallback: 'Something went wrong with the wallet connection.', reload: 'Reload page' },
  de: { title: 'Wallet-Fehler', fallback: 'Bei der Wallet-Verbindung ist etwas schiefgegangen.', reload: 'Seite neu laden' },
} as const;

const text = () => (typeof document !== 'undefined' && document.documentElement.lang.startsWith('de') ? TEXT.de : TEXT.en);

export class WalletErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Wallet error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    const t = text();
    return (
      <div role="alert" className="my-4 rounded-lg border border-red-700 bg-red-950/30 p-4 text-white">
        <div className="mb-2 flex items-center gap-2">
          <AlertCircle className="text-red-500" size={20} aria-hidden="true" />
          <h3 className="font-medium">{t.title}</h3>
        </div>
        <p className="mb-3 text-sm text-white/80">{t.fallback}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex items-center gap-1 rounded-md bg-white/10 px-3 py-1.5 text-sm transition hover:bg-white/20"
        >
          <RefreshCw size={14} aria-hidden="true" />
          <span>{t.reload}</span>
        </button>
      </div>
    );
  }
}
