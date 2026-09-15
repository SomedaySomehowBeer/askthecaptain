'use client';
import { useActionState } from 'react';
import type { Company, Contact } from './people.ts';
import { savePerson } from './actions.ts';
function Feedback({ state }: { state: { error?: string; ok?: boolean } | undefined }) {
 return <>{state?.error ? <p role="alert" className="form__error">{state.error}</p> : null}{state?.ok ? <p role="status" className="muted">Saved.</p> : null}</>;
}
export function ContactForm({ contact, companies }: { contact?: Contact; companies: Company[] }) {
 const [state, action, pending] = useActionState(savePerson, undefined);
 return <form action={action} className="form"><input type="hidden" name="id" value={contact?.id ?? ''} />
  <fieldset disabled={pending || Boolean(contact?.archivedAt)} className="stack people-fields">
   <div className="field"><label htmlFor="person-name">Name</label><input id="person-name" name="name" type="text" defaultValue={contact?.name} maxLength={200} /></div>
   <div className="field"><label htmlFor="person-email">Email</label><input id="person-email" name="email" type="email" required defaultValue={contact?.email} maxLength={254} /></div>
   <div className="field"><label htmlFor="person-company">Company</label><select id="person-company" name="companyId" defaultValue={contact?.companyId ?? ''}><option value="">No company</option>
    {contact?.companyId && !companies.some((c) => c.id === contact.companyId) ? <option value={contact.companyId}>{contact.companyName} (current company)</option> : null}
    {companies.map((c) => <option key={c.id} value={c.id} disabled={Boolean(c.archivedAt) && c.id !== contact?.companyId}>{c.name}{c.archivedAt ? ' (archived)' : ''}</option>)}
   </select></div>
   <div className="field"><label htmlFor="person-phone">Phone</label><input id="person-phone" name="phone" type="text" inputMode="tel" defaultValue={contact?.phone} maxLength={80} /></div>
   <div className="field"><label htmlFor="person-role">Role</label><input id="person-role" name="role" type="text" defaultValue={contact?.role} maxLength={200} /></div>
   <div className="field"><label htmlFor="person-notes">Notes</label><textarea id="person-notes" name="notes" rows={3} defaultValue={contact?.notes} maxLength={5000} /></div>
   <div><button className="button button--secondary" type="submit">{pending ? 'Saving…' : contact ? 'Save contact' : 'Add contact'}</button></div>
  </fieldset><Feedback state={state} />
 </form>;
}
export function CompanyForm({ company }: { company?: Company }) {
 const [state, action, pending] = useActionState(savePerson, undefined); const prefix = company?.id ?? 'new-company';
 return <form action={action} className="form"><input type="hidden" name="kind" value="company" /><input type="hidden" name="id" value={company?.id ?? ''} />
  <fieldset disabled={pending || Boolean(company?.archivedAt)} className="stack people-fields">
   <div className="field"><label htmlFor={`${prefix}-name`}>Company name</label><input id={`${prefix}-name`} name="name" type="text" required defaultValue={company?.name} maxLength={200} /></div>
   <div className="field"><label htmlFor={`${prefix}-domain`}>Email domain</label><input id={`${prefix}-domain`} name="domain" type="text" placeholder="example.com" defaultValue={company?.domain ?? ''} maxLength={253} /></div>
   <div className="field"><label htmlFor={`${prefix}-notes`}>Company notes</label><textarea id={`${prefix}-notes`} name="notes" defaultValue={company?.notes} maxLength={5000} rows={2} /></div>
   <div><button className="button button--secondary">{pending ? 'Saving…' : company ? 'Save company' : 'Add company'}</button></div>
  </fieldset><Feedback state={state} />
 </form>;
}
export function ArchiveForm({ id, archived, company = false }: { id: string; archived: boolean; company?: boolean }) {
 const [state, action, pending] = useActionState(savePerson, undefined);
 return <form action={action}><input type="hidden" name="kind" value={company ? 'company' : 'contact'} /><input type="hidden" name="id" value={id} /><input type="hidden" name="archived" value={String(!archived)} />
  <button className="button button--ghost" disabled={pending}>{pending ? 'Saving…' : archived ? 'Restore' : 'Archive'}</button><Feedback state={state} />
 </form>;
}
