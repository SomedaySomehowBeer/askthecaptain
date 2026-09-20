-- The retrieval index (D21): vectors are mail-derived data under the same policy as mail, kept in
-- the tenant's own rows, cascading with their source, never logged or exported on their own.
create extension if not exists vector;
create table content_vectors (
	organisation_id uuid not null references organisations(id) on delete cascade,
	source_kind text not null check (source_kind in ('mail_message', 'note')),
	source_id uuid not null,
	chunk_index integer not null default 0 check (chunk_index >= 0),
	encoder text not null, encoder_version text not null,
	-- The digest says which text was embedded, so an edited note is embedded again; tokens is the
	-- unit's own length (an estimate), the weight a message carries in its thread vector.
	digest text not null, tokens integer not null check (tokens >= 0),
	-- A short reply carries its parent's vector rather than one of its own (plan: the index).
	inherited boolean not null default false,
	vector vector(384) not null,
	embedded_at timestamptz not null default now(),
	primary key (organisation_id, source_kind, source_id, chunk_index)
);
alter table content_vectors enable row level security; alter table content_vectors force row level security;
create policy content_vectors_tenant on content_vectors for all to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
-- Cascades with the source. A polymorphic source cannot carry a foreign key, so a delete trigger does it,
-- including deletes that arrive by cascade from a thread or a connection.
create function content_vectors_cascade() returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
	delete from public.content_vectors where organisation_id = old.organisation_id and source_kind = tg_argv[0] and source_id = old.id;
	return old;
end $$;
revoke all on function content_vectors_cascade() from public;
create trigger mail_messages_content_vectors after delete on mail_messages for each row execute function content_vectors_cascade('mail_message');
create trigger notes_content_vectors after delete on notes for each row execute function content_vectors_cascade('note');
-- The thread vector (weighted mean of its messages) and the note vector (mean of its chunks), each tagged with its encoder.
alter table mail_threads add column vector vector(384), add column vector_encoder text;
alter table notes add column vector vector(384), add column vector_encoder text;
create index mail_threads_vector on mail_threads using hnsw (vector vector_cosine_ops);
create index notes_vector on notes using hnsw (vector vector_cosine_ops);
create index content_vectors_vector on content_vectors using hnsw (vector vector_cosine_ops);
-- Narrow discovery for the hourly fill: tenant IDs only, never content.
create function index_organisations() returns table (organisation_id uuid)
	language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
		select distinct organisation_id from public.mail_threads union select distinct organisation_id from public.notes
	$$;
revoke all on function index_organisations() from public;
grant execute on function index_organisations() to app;
grant select, insert, update, delete on content_vectors to app;
