import { Page, requireCurrent } from '../../../components/Page.tsx';
import { StockSection } from '../../commitments/Stock.tsx';
export const metadata = { title: 'Inventory' };
export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ shopifyOffset?: string }> }) {
 const me = await requireCurrent('/resources/inventory');
 const query = await searchParams;
 const shopifyOffset = /^\d{1,7}$/.test(query.shopifyOffset ?? '') ? Math.min(1_000_000, Number(query.shopifyOffset)) : 0;
 return <Page title="Inventory">{await StockSection({ me, shopifyOffset, basePath: '/resources/inventory' })}</Page>;
}
