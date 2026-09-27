import { ShopifyCard } from './ShopifyCard.tsx';
import { XeroCard } from './XeroCard.tsx';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
export const metadata: Metadata = { title: 'Connections' };
/** Business accounts: Xero and Shopify. Google mail and calendar access belonged to the retired assistant and is no
 *  longer part of Captain (#133); Google sign-in is separate and unaffected. */
export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ xero?: string; shopify?: string }> }) {
	const me = await requireCurrent('/settings/connections'); const query = await searchParams;
	return <Page title="Connections" lede={me.organisation.organisationName}>
		<Suspense fallback={<div role="status"><Notice>Checking Xero…</Notice></div>}><XeroCard me={me} outcome={query.xero} /></Suspense>
		<Suspense fallback={<p role="status">Checking Shopify…</p>}><ShopifyCard me={me} outcome={query.shopify} /></Suspense>
	</Page>;
}
