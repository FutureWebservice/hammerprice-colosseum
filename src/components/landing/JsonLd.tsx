import { jsonLdString } from './seo';

/** One structured-data block. A server component: the JSON is in the first HTML byte, no script runs. */
export default function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(data) }} />;
}
