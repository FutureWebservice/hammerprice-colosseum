import AiPage, { aiPageMetadata } from '@/components/ai/AiPage';
import { locales } from '@/lib/i18n';

export const generateStaticParams = () => locales.map((locale) => ({ locale }));
// The page reads the deployment's environment (is the AI switched off?), like the landing page (cached for five minutes).
export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  return aiPageMetadata((await params).locale);
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  return <AiPage locale={(await params).locale} />;
}
