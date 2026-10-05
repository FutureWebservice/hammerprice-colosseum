/**
 * One look for every "nothing here" page: the 404, the error page, an empty list, a proof that cannot be loaded. The landing language: the brass
 * rule, a mono kicker, big serif type, a solid brass primary button and a quiet outlined second one. It takes plain strings (each caller picks
 * its own message namespace) and plain actions, so the same panel serves server pages, client pages and the packs and verify screens.
 *
 * `page` fills a screen (404, error); `compact` sits inside a page that already has its own head (an empty catalogue, a missing proof).
 */
import type { ReactNode } from 'react';
import './state-panel.css';
import { SYMBOL_SRC } from '@/components/brand/Logo';

/** The class names an action needs: `sp-btn` (solid brass, the primary one) and `sp-btn sp-btn--alt` (outlined). */
export const SP_PRIMARY = 'sp-btn';
export const SP_ALT = 'sp-btn sp-btn--alt';

export interface StatePanelProps {
  kicker: string;
  title: string;
  /** The explanation: one or two short sentences. */
  children?: ReactNode;
  /** Links and buttons, primary first. Use SP_PRIMARY and SP_ALT for their class. */
  actions?: ReactNode;
  variant?: 'page' | 'compact';
  /** The heading level: h1 for a page of its own, h2 inside a page that has an h1. */
  as?: 'h1' | 'h2';
  /** `alert` for a failure, `status` for a neutral empty state. */
  role?: 'alert' | 'status';
  testId?: string;
}

export default function StatePanel({ kicker, title, children, actions, variant = 'page', as: Tag = variant === 'page' ? 'h1' : 'h2', role, testId }: StatePanelProps) {
  return (
    <section className={`sp sp--${variant}`} role={role} data-testid={testId}>
      <div className="sp-card">
        {variant === 'page' ? (
          // eslint-disable-next-line @next/next/no-img-element -- a small SVG file, decorative
          <img className="sp-mark" src={SYMBOL_SRC} alt="" width={31} height={44} />
        ) : (
          <div className="sp-rule" aria-hidden="true" />
        )}
        <p className="sp-kicker">{kicker}</p>
        <Tag className="sp-title">{title}</Tag>
        {children ? <p className="sp-body">{children}</p> : null}
        {actions ? <div className="sp-actions">{actions}</div> : null}
      </div>
    </section>
  );
}
