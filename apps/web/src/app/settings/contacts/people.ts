export type Company = { id: string; name: string; domain: string | null; notes: string; archivedAt: string | null };
export type Contact = { id: string; name: string; email: string; companyId: string | null; companyName: string | null; phone: string; role: string; notes: string; source: string; archivedAt: string | null };
export type ContactDetail = { contact: Contact; threads: { id: string; subject: string; sentAt: string }[] };
export type ContactList = { contacts: Contact[]; hasMore: boolean };
export type CompanyList = { companies: Company[]; hasMore: boolean };
