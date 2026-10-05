'use client';

/** The whole glossary as a list, for the FAQ page (id="glossary", which the help menu links to). Same words as <Term>. */
import type { Cluster } from '@/contracts';
import { useGlossary } from './useGlossary';
import '../explain/ux.css';

export default function GlossaryList({ as: H = 'h2', cluster }: { as?: 'h2' | 'h3'; cluster?: Cluster }) {
  const g = useGlossary(cluster);
  return (
    <section className="ux-glossary" id="glossary" aria-labelledby="ux-glossary-title" data-testid="glossary-list">
      <H id="ux-glossary-title">{g.listTitle}</H>
      <dl>
        {g.ids.map((id) => (
          <div key={id} className="ux-glossary-item" data-term={id}>
            <dt>{g.label(id)}</dt>
            <dd>{g.text(id)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
