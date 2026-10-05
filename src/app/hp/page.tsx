import { redirect } from 'next/navigation';
import { defaultLocale } from '@/lib/i18n';

/**
 * /hp is the URL in the submission. It used to render the landing component bare, outside
 * the locale layout, which meant no header, no footer, no explain bubble, and, once the
 * locale pages got their shared footer, a second footer whenever the same component was
 * rendered inside them. One landing, one chrome: send the locale-free URL to the default
 * locale and let the layout do the rest.
 */
export default function Page() {
  redirect(`/${defaultLocale}`);
}
