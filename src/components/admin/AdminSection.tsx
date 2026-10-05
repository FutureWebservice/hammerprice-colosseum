import Link from 'next/link';
import type { Cell, Section } from '@/server/admin/data';
import ActionButton from './ActionButton';

/** One admin section: title, search, tabs, the table, paging. Plain on purpose (English only, desktop first). */
export default function AdminSection({ data, locale }: { data: Section; locale: string }) {
  const base = `/${locale}/admin${data.key === 'overview' ? '' : `/${data.key}`}`;
  const href = (o: { page?: number; tab?: string }) => {
    const sp = new URLSearchParams();
    const tab = o.tab ?? data.tab;
    if (tab) sp.set('tab', tab);
    if (data.q) sp.set('q', data.q);
    if (o.page && o.page > 1) sp.set('page', String(o.page));
    const s = sp.toString();
    return s ? `${base}?${s}` : base;
  };
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const searchable = data.key !== 'overview';

  return (
    <section>
      <h1 className="text-2xl font-medium">{data.title}</h1>
      {data.note ? <p className="mt-1 text-sm text-white/60">{data.note}</p> : null}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        {data.tabs ? (
          <nav aria-label="Views" className="flex gap-1">
            {data.tabs.map((t) => (
              <Link key={t.key} href={href({ tab: t.key })} aria-current={t.key === data.tab ? "page" : undefined}
                className={`rounded px-3 py-1 text-sm ${t.key === data.tab ? 'bg-white/15' : 'hover:bg-white/10'}`}>{t.label}</Link>
            ))}
          </nav>
        ) : null}
        {searchable ? (
          <form method="get" action={base} className="flex gap-2">
            {data.tab ? <input type="hidden" name="tab" value={data.tab} /> : null}
            <input name="q" defaultValue={data.q} placeholder="Search" aria-label="Search" maxLength={100} className="rounded border border-white/20 bg-transparent px-2 py-1 text-sm" />
            <button type="submit" className="rounded border border-white/20 px-3 py-1 text-sm hover:bg-white/10">Search</button>
          </form>
        ) : null}
        {data.exportHref ? <a href={data.exportHref} className="rounded border border-white/20 px-3 py-1 text-sm hover:bg-white/10">Export CSV</a> : null}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-white/20 text-white/60">{data.columns.map((c, i) => <th key={i} scope="col" className="px-2 py-2 font-normal">{c}</th>)}</tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={i} className="border-b border-white/10 align-top">{r.map((c, j) => <td key={j} className="px-2 py-2 break-words">{render(c)}</td>)}</tr>
            ))}
            {data.rows.length === 0 ? <tr><td colSpan={data.columns.length} className="px-2 py-6 text-white/50">Nothing here.</td></tr> : null}
          </tbody>
        </table>
      </div>

      {data.key !== 'overview' ? (
        <div className="mt-4 flex items-center gap-4 text-sm text-white/70">
          {data.page > 1 ? <Link href={href({ page: data.page - 1 })}>Previous</Link> : <span className="opacity-40">Previous</span>}
          <span>Page {data.page} of {pages} ({data.total} rows)</span>
          {data.page < pages ? <Link href={href({ page: data.page + 1 })}>Next</Link> : <span className="opacity-40">Next</span>}
        </div>
      ) : null}
    </section>
  );
}

function render(c: Cell) {
  if (c === null || c === '') return null;
  if (typeof c === 'string' || typeof c === 'number') return c;
  if ('action' in c) return <ActionButton action={c.action} id={c.id} label={c.label} confirmText={c.confirm} />;
  if (!c.href) return <span title={c.title}>{c.text}</span>;
  return c.href.startsWith('http')
    ? <a href={c.href} target="_blank" rel="noopener noreferrer" title={c.title} className="underline">{c.text}</a>
    : <Link href={c.href} title={c.title} className="underline">{c.text}</Link>;
}
