export type Company = { id: string; name: string; domain: string | null; notes: string; archivedAt: string | null };
export type Contact = { id: string; name: string; email: string; companyId: string | null; companyName: string | null; phone: string; role: string; notes: string; source: string; archivedAt: string | null };
/** The API may still include legacy mail threads; People never shows them (#133). */
export type ContactDetail = { contact: Contact };
export type ContactList = { contacts: Contact[]; hasMore: boolean };
export type CompanyList = { companies: Company[]; hasMore: boolean };
