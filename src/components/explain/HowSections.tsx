/**
 * The "How it works" section of /about (id="how"; it was the page /how-it-works, which redirects here): the whole path in six short
 * steps for the three roles, buyer, seller and room host. Each step names who it is for. The image strip (the showcase) follows
 * directly under it, composed by AboutPage.
 */
import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/config';
import { getPitchMessages } from '@/components/pitch/content';
import Go from '@/components/pitch/Go';
import '@/components/pitch/pitch.css';

export default function HowSections({ locale }: { locale: string }) {
  const l: Locale = isLocale(locale) ? locale : defaultLocale;
  const m = getPitchMessages(l).how;

  return (
    <section className="pt-sec" id="how" aria-labelledby="pt-how-h">
      <p className="pt-kicker">{m.kicker}</p>
      <h2 id="pt-how-h">{m.heading}</h2>
      <p className="pt-lede">{m.intro}</p>
      <ol className="pt-how">
        {m.steps.map((s, i) => (
          <li className="pt-how-step pt-glass" key={s.title}>
            <span className="pt-how-no" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
            <ul className="pt-chips">
              {s.roles.map((r) => (
                <li key={r} className={`pt-chip pt-chip--${r}`}>{m.roles[r as keyof typeof m.roles]}</li>
              ))}
            </ul>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
            {s.link && <Go href={s.link.href} locale={l} className="pt-textlink">{s.link.label}</Go>}
          </li>
        ))}
      </ol>
    </section>
  );
}
