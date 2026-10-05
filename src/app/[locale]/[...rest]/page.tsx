import { notFound } from 'next/navigation';

/** Any address under a language that matches no page: the branded 404 of [locale]/not-found.tsx instead of the bare one. */
export default function CatchAll() {
  notFound();
}
