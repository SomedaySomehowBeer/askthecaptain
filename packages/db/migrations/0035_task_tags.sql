-- Flat workspace labels (D7): tags select existing tasks, never create areas or permissions.
create table tags (
 id uuid primary key default uuidv7(),
 organisation_id uuid not null references organisations(id) on delete cascade,
 name text not null check (name = btrim(name) and length(name) between 1 and 60),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (organisation_id, id)
);
create unique index tags_name on tags (organisation_id, lower(name));
create table task_tags (
 organisation_id uuid not null references organisations(id) on delete cascade,
 task_id uuid not null,
 tag_id uuid not null,
 attached_by uuid not null,
 attached_at timestamptz not null default now(),
 primary key (organisation_id, task_id, tag_id),
 foreign key (organisation_id, task_id) references tasks(organisation_id, id) on delete cascade,
 foreign key (organisation_id, tag_id) references tags(organisation_id, id) on delete cascade,
 foreign key (organisation_id, attached_by) references memberships(organisation_id, user_id)
);
create index task_tags_by_tag on task_tags (organisation_id, tag_id, task_id);
alter table tags enable row level security;
alter table tags force row level security;
create policy tags_member on tags for all to app
 using (organisation_id = current_organisation_id() and exists (
  select 1 from memberships m where m.organisation_id = tags.organisation_id
   and m.user_id = current_user_id() and m.status = 'active'))
 with check (organisation_id = current_organisation_id() and exists (
  select 1 from memberships m where m.organisation_id = tags.organisation_id
   and m.user_id = current_user_id() and m.status = 'active'));
alter table task_tags enable row level security;
alter table task_tags force row level security;
create policy task_tags_member_read on task_tags for select to app
 using (organisation_id = current_organisation_id() and exists (
  select 1 from memberships m where m.organisation_id = task_tags.organisation_id
   and m.user_id = current_user_id() and m.status = 'active'));
create policy task_tags_member_insert on task_tags for insert to app
 with check (organisation_id = current_organisation_id() and attached_by = current_user_id() and exists (
  select 1 from memberships m where m.organisation_id = task_tags.organisation_id
   and m.user_id = current_user_id() and m.status = 'active'));
create policy task_tags_member_delete on task_tags for delete to app
 using (organisation_id = current_organisation_id() and exists (
  select 1 from memberships m where m.organisation_id = task_tags.organisation_id
   and m.user_id = current_user_id() and m.status = 'active'));
-- Labels can be renamed; deletion/archival is a later UI/lifecycle decision.
grant select, insert, update on tags to app;
grant select, insert, delete on task_tags to app;
