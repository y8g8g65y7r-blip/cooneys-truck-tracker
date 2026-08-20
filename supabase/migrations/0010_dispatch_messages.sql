-- ============================================================
-- 0010 — Dispatch messages (driver <-> dispatch communication)
--
-- Context: Dario asked for drivers and dispatchers — or, on a subcontracted
-- job, dispatch and the subcontractor's driver (subcontractors are not a
-- separate account type here; see the free-text `subcontractor` field on
-- haul_tickets in 0009 — a subcontracted driver just logs in as an ordinary
-- `driver` row) — to be able to talk to each other about a specific job.
--
-- A message is scoped to ONE dispatch, not a standing DM: Dario's ask was
-- "on dispatches", and scoping it to the job means the thread rides along
-- with job history for free and never needs its own separate access-control
-- story — RLS just asks "is this dispatch yours (or are you staff)", exactly
-- like every other per-dispatch table here.
--
-- Idempotent: safe to re-run.
-- ============================================================

create table if not exists public.dispatch_messages (
  id           uuid primary key default gen_random_uuid(),
  dispatch_id  uuid not null references public.dispatches on delete cascade,
  sender_id    uuid not null references auth.users on delete cascade,
  body         text not null,
  created_at   timestamptz not null default now()
);

-- Typed on a phone, sometimes one-handed. This also bounds the push-alert
-- payload (APNs caps a whole payload at 4KB; see send-message-push).
alter table public.dispatch_messages
  drop constraint if exists dispatch_messages_body_length;
alter table public.dispatch_messages
  add constraint dispatch_messages_body_length check (char_length(body) between 1 and 1000);

create index if not exists dispatch_messages_dispatch_created_idx
  on public.dispatch_messages (dispatch_id, created_at);

alter table public.dispatch_messages enable row level security;

do $$
begin
  -- Driver: read/write only on a dispatch that is actually theirs.
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'dispatch_messages' and policyname = 'Drivers view own dispatch messages') then
    create policy "Drivers view own dispatch messages" on public.dispatch_messages
      for select to authenticated
      using (exists (
        select 1 from public.dispatches d
        where d.id = dispatch_messages.dispatch_id and d.driver_id = auth.uid()
      ));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'dispatch_messages' and policyname = 'Drivers send on own dispatches') then
    create policy "Drivers send on own dispatches" on public.dispatch_messages
      for insert to authenticated
      with check (
        sender_id = auth.uid()
        and exists (
          select 1 from public.dispatches d
          where d.id = dispatch_messages.dispatch_id and d.driver_id = auth.uid()
        )
      );
  end if;

  -- Admin/dispatcher: read/write on any dispatch. Same "staff see all" shape
  -- as every other table here.
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'dispatch_messages' and policyname = 'Staff view all dispatch messages') then
    create policy "Staff view all dispatch messages" on public.dispatch_messages
      for select to authenticated
      using (public.get_my_role() in ('admin', 'dispatcher'));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'dispatch_messages' and policyname = 'Staff send on any dispatch') then
    create policy "Staff send on any dispatch" on public.dispatch_messages
      for insert to authenticated
      with check (sender_id = auth.uid() and public.get_my_role() in ('admin', 'dispatcher'));
  end if;

  -- Deliberately no update/delete policy for anyone. A message thread is a
  -- record of what was actually said, same rule 0009 applied to a submitted
  -- haul ticket — nobody edits history after the fact.
end $$;

-- Realtime: instant delivery while the app is open, same as dispatches (0004).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dispatch_messages'
  ) then
    alter publication supabase_realtime add table public.dispatch_messages;
  end if;
end $$;
