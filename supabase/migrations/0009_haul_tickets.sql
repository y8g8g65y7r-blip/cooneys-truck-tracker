-- ============================================================
-- 0009 — Haul tickets (replacing the paper book)
--
-- Mirrors Cooney's existing pre-printed haul ticket. A ticket is its own
-- business document, not a property of a dispatch: it carries its own number,
-- its own customer sign-off, and Matt intends to make it contractual (no
-- ticket = no pay for subs and employees). So it gets its own table rather
-- than more columns on dispatches — which also keeps it clear of
-- protect_dispatch_columns(), the trigger that has now twice silently eaten a
-- new driver-writable field.
--
-- TICKET NUMBERING — A BUSINESS DECISION, FLAGGED FOR MATT:
--   The paper book is pre-printed and sequential (the sample was #42200) and
--   that stock is still in circulation. Continuing the same run from the app
--   would eventually collide with a physical ticket carrying the same number,
--   on documents that are about to become contractual. So electronic tickets
--   run their OWN sequence starting at 100001 and are DISPLAYED WITH AN "E"
--   PREFIX (E100001) so a ticket number is unambiguous at a glance in an
--   invoice dispute. Easy to change later; deliberately not buried.
--
-- Idempotent: safe to re-run.
-- ============================================================

create sequence if not exists public.haul_ticket_no_seq start with 100001 increment by 1;

create table if not exists public.haul_tickets (
  id                    uuid primary key default gen_random_uuid(),
  ticket_no             bigint not null default nextval('public.haul_ticket_no_seq') unique,
  driver_id             uuid not null references auth.users on delete cascade,
  dispatch_id           uuid references public.dispatches on delete set null,

  -- 'electronic' = the form below is filled in.
  -- 'photo'      = the driver shot the paper ticket instead; photo_path is the
  --                record and most form fields stay null. Both are first-class:
  --                some sites require the physical pink copy be left behind.
  method                text not null check (method in ('electronic', 'photo')),
  -- Present so that if drafts are ever persisted server-side, the
  -- "management never sees an unsubmitted ticket" guarantee is already
  -- enforced by the admin SELECT policy below rather than by app code.
  status                text not null default 'submitted' check (status in ('draft', 'submitted')),

  ticket_date           date,
  customer              text,
  job_number            text,
  site_address          text,
  subcontractor         text,
  driver_name           text,
  truck_number          text,
  trailer_number        text,
  equipment             text,

  description_of_work   text,
  rate_amount           numeric,      -- $ per rate_unit
  rate_unit             text,         -- 'hour' | 'load' | 'lump'
  quantity              numeric,      -- hours or loads billed
  subtotal              numeric,
  gst                   numeric,
  total                 numeric,

  start_time            time,
  finish_time           time,
  total_hours           numeric,
  time_on_site_minutes  integer,
  minimum_charge_note   text,

  loads_count           integer,
  material_notes        text,
  -- Per-load Loaded/Dumped/Cycle/Scale. jsonb rather than a child table: the
  -- rows are written once, always read as a whole, and never queried across
  -- tickets. Pre-filled from the GPS leg segmentation (see www/legs.js) and
  -- then editable — hand-typing four timestamps per load on a phone is how you
  -- guarantee nobody fills the ticket in at all.
  load_detail           jsonb not null default '[]'::jsonb,

  customer_approval_name text,
  customer_approval_date date,

  photo_path            text,         -- object in the job-photos bucket

  created_at            timestamptz not null default now(),
  submitted_at          timestamptz not null default now()
);

create index if not exists haul_tickets_driver_created_idx
  on public.haul_tickets (driver_id, created_at desc);
create index if not exists haul_tickets_dispatch_idx
  on public.haul_tickets (dispatch_id);

alter table public.haul_tickets enable row level security;

do $$
begin
  -- Driver: writes and reads only their own. Same shape as everything else here.
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'haul_tickets' and policyname = 'Drivers insert own tickets') then
    create policy "Drivers insert own tickets" on public.haul_tickets
      for insert to authenticated with check (auth.uid() = driver_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'haul_tickets' and policyname = 'Drivers view own tickets') then
    create policy "Drivers view own tickets" on public.haul_tickets
      for select to authenticated using (auth.uid() = driver_id);
  end if;

  -- Management sees a ticket only once it has actually been submitted.
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'haul_tickets' and policyname = 'Staff view submitted tickets') then
    create policy "Staff view submitted tickets" on public.haul_tickets
      for select to authenticated
      using (status = 'submitted' and public.get_my_role() in ('admin', 'dispatcher'));
  end if;

  -- Deliberately NO driver update/delete policy. A ticket that is about to
  -- carry a customer's signature and drive pay is a record, not a scratchpad —
  -- once submitted the driver cannot revise it. Office staff can correct one.
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'haul_tickets' and policyname = 'Staff correct tickets') then
    create policy "Staff correct tickets" on public.haul_tickets
      for update to authenticated
      using (public.get_my_role() in ('admin', 'dispatcher'));
  end if;
end $$;
