-- ============================================================
-- Cooney's Trucking — Migration 0003: backward-compatible roles
--
-- Context: the app is a native (Capacitor) build with www/ bundled on-device,
-- so installed clients cannot update instantly. 0002 renamed the privileged
-- role dispatcher -> admin, which breaks the *installed* app (it still checks
-- role = 'dispatcher'). This migration makes a privileged user be recognised
-- under BOTH 'dispatcher' and 'admin', so the old installed app and the new
-- build both work during rollout. Existing privileged users are set back to
-- 'dispatcher' (see the ops step run alongside this) so the installed app works
-- immediately; once everyone is on the new build you can standardise on 'admin'.
--
-- Run once. Safe to re-run (drop-if-exists guards throughout).
-- ============================================================

-- 1. Allow all three role values during the transition.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('driver', 'dispatcher', 'admin'));

-- 2. RLS: privileged = role in ('admin','dispatcher'). Recreate each policy.
-- profiles
drop policy if exists "Admins view all profiles" on public.profiles;
create policy "Admins view all profiles" on public.profiles
  for select using (public.get_my_role() in ('admin', 'dispatcher'));

drop policy if exists "Admins update all profiles" on public.profiles;
create policy "Admins update all profiles" on public.profiles
  for update using (public.get_my_role() in ('admin', 'dispatcher'));

-- location_updates
drop policy if exists "Admins view all locations" on public.location_updates;
create policy "Admins view all locations" on public.location_updates
  for select using (public.get_my_role() in ('admin', 'dispatcher'));

-- dispatches
drop policy if exists "Admins view all dispatches" on public.dispatches;
create policy "Admins view all dispatches" on public.dispatches
  for select using (public.get_my_role() in ('admin', 'dispatcher'));

drop policy if exists "Admins insert dispatches" on public.dispatches;
create policy "Admins insert dispatches" on public.dispatches
  for insert with check (public.get_my_role() in ('admin', 'dispatcher'));

drop policy if exists "Admins update all dispatches" on public.dispatches;
create policy "Admins update all dispatches" on public.dispatches
  for update using (public.get_my_role() in ('admin', 'dispatcher'));

-- 3. Guard triggers: treat both 'admin' and 'dispatcher' as privileged (do NOT
--    clamp their column changes). The functions are replaced in place; the
--    existing triggers keep pointing at them.
create or replace function public.protect_profile_privileged_columns()
returns trigger as $$
begin
  if auth.uid() is not null
     and public.get_my_role() is distinct from 'admin'
     and public.get_my_role() is distinct from 'dispatcher' then
    new.role := old.role;
    new.employment_type := old.employment_type;
    new.active := old.active;
  end if;
  return new;
end;
$$ language plpgsql security definer;

create or replace function public.protect_dispatch_columns()
returns trigger as $$
begin
  if auth.uid() is not null
     and public.get_my_role() is distinct from 'admin'
     and public.get_my_role() is distinct from 'dispatcher' then
    new.driver_id    := old.driver_id;
    new.site_address := old.site_address;
    new.lat          := old.lat;
    new.lng          := old.lng;
    new.notes        := old.notes;
    new.created_by   := old.created_by;
    new.created_at   := old.created_at;
  end if;
  return new;
end;
$$ language plpgsql security definer;
