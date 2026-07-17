# Deploying the Admin Roles + Brand update

This branch adds an **Admin** role that provisions employees from inside the app,
and rebrands the PWA to the real Cooney's Trucking look. Two backend pieces must
be applied to Supabase once, then the web build ships as usual.

## Roles

| Role | Sees | Can do |
| ---- | ---- | ------ |
| `admin` | everything (all drivers, all locations, all dispatches) | send dispatches, view the live map, **add / manage employees** |
| `driver` | only their own dispatch + their own GPS | drive, get directions, mark jobs complete |

Each driver also has an `employment_type` of `staff` or `contractor` (for
reporting) and an `active` flag (soft-disable without deleting history).

**Role values during the native-app rollout.** Because the app is a native
build with `www/` bundled on-device, installed phones can't update instantly.
The DB, RLS, Edge Function, and new frontend therefore treat **both**
`dispatcher` and `admin` as privileged (migration `0003`). Existing privileged
users stay `dispatcher` so the *installed* app keeps working; the new build
accepts either. Once every admin is on the new build you can standardise on
`admin` with a single `UPDATE` — nothing else needs to change.

## 1. Apply the database migration

Run **`supabase/migrations/0002_admin_roles.sql`** once against the project
(Supabase Dashboard → SQL Editor → paste → Run), or with the CLI:

```bash
supabase db push        # if you use the CLI + linked project
```

It renames the old `dispatcher` role to `admin`, adds `employment_type` + `active`,
and hardens the signup trigger. It is safe to run once on the existing database.

> A brand-new project can instead run the full **`setup.sql`** — it already
> reflects the same end state.

## 2. Deploy the Edge Function (in-app "Add Employee")

The app can't create logins with the public anon key, so provisioning goes
through a server-side function that holds the service-role key.

```bash
supabase functions deploy admin-create-employee --project-ref <ref>
```

You do **not** set any secret. Supabase auto-injects `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` into every Edge Function at
runtime (and it actually blocks setting any secret whose name starts with
`SUPABASE_`). So deploying the function is enough — `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`
works out of the box. The service-role key stays server-side; it is never in
`www/` and never sent to the browser.

## 3. Promote your first admin

The signup trigger always creates **drivers** (on purpose — it must not trust
signup metadata). Promote a real admin once, from the SQL Editor:

```sql
UPDATE public.profiles SET role = 'admin' WHERE full_name = 'Kale';
-- or by the user's email via auth.users if you prefer
```

After that, admins add everyone else from the app — no SQL needed.

## 4. Add employees from the app

Sign in as an admin → **Employees** → fill name / email / unit / staff-or-contractor
/ a temp password (or hit **Generate**) → **Add Employee**. The temp password is
shown once for handoff; the driver can change it after first sign-in. Toggle
`staff`/`contractor` or deactivate a driver from the roster rows.

## Security notes (from the multi-model review)

- The signup trigger never reads `role` from user metadata (prevents anon
  self-signup from self-promoting to admin).
- A `BEFORE UPDATE` trigger stops a non-admin from changing `role` / `active` /
  `employment_type` on their own profile row. The trusted SQL-editor / service
  path (null `auth.uid()`) is exempt so the bootstrap in step 3 still works.
- All database-derived text is HTML-escaped before rendering (no stored XSS via
  driver names or dispatch addresses).
- `www/config.js` holds only the publishable/anon key — safe to commit.

## Verifying end-to-end

1. Migration applied → `profiles` has `employment_type` + `active`, and the one
   pre-existing dispatcher is now `role='admin'`.
2. Call the function without an admin JWT → expect **403** `Admin access required`.
3. Sign in as admin → add an employee → that person can sign in with the temp
   password and sees **only their own** dispatch/GPS (cannot open the dispatch,
   map, or employees pages — they redirect).
4. Existing dispatch send + live map still work.
