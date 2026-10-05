import type { Check } from '@/lib/vrf';
import type { VrfT } from './text';

const MARK: Record<Check['status'], string> = { pass: '✓', fail: '✗', skipped: '–', unverifiable: '?' };

/** The verifier's rules, in rule order, split into the five that need nothing but this page's data and the four that read the network. */
export default function Checklist({ checks, t }: { checks: readonly Check[]; t: VrfT }) {
  const groups: { kind: Check['kind']; items: Check[] }[] = [
    { kind: 'crypto', items: checks.filter((c) => c.kind === 'crypto') },
    { kind: 'chain', items: checks.filter((c) => c.kind === 'chain') },
  ];
  return (
    <div data-testid="vrf-checklist">
      {groups.filter((g) => g.items.length > 0).map((g) => (
        <section key={g.kind} aria-label={t(`checks.${g.kind}`)}>
          <h3 className="vrf-group">{t(`checks.${g.kind}`)}</h3>
          <ul className="vrf-checks">
            {g.items.map((c) => (
              <li key={c.id} className="vrf-check" data-testid={`vrf-check-${c.id}`} data-status={c.status}>
                <span className="vrf-check-mark"><span aria-hidden="true">{MARK[c.status]} </span>{t(`checks.status.${c.status}`)}</span>
                <span className="vrf-check-title">{t(`checks.${c.id}.title`)}</span>
                <p className="vrf-check-how">{t(`checks.${c.id}.how`)}</p>
                {c.detail && c.status !== 'pass' && <p className="vrf-check-detail" lang="en">{c.detail}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
