// ============================================================
// Cooney's Trucking — Edge Function: admin-create-employee
//
// Purpose: Securely provision a new Driver auth user (staff/contractor) with a
//   temp password, on behalf of an authenticated ADMIN, WITHOUT the service_role
//   key ever reaching the client. The caller's JWT is verified admin-side; only
//   a caller whose profiles.role === 'admin' may create employees. The DB trigger
//   handle_new_user() creates the matching profiles row from user_metadata.
//
// Deploy:
//   supabase functions deploy admin-create-employee
//
// Required secret (server-only — set ONCE, never commit, never send to client):
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
//
// Note: SUPABASE_URL and SUPABASE_ANON_KEY are auto-injected into the Functions
//   runtime by Supabase — you do NOT need to set them as secrets.
//
// Key discipline:
//   * anon / publishable key  -> client-side (www/config.js), safe to commit.
//   * service_role key        -> server-only, read at runtime from Deno.env,
//                                never a literal in this file and never returned
//                                in any response body.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Helper: JSON response that ALWAYS carries CORS headers.
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  // 1. CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
      return json({ ok: false, error: 'Server not configured' }, 500)
    }

    // 2. Require an Authorization header (caller JWT).
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ ok: false, error: 'Missing authorization' }, 401)
    }

    // 3. Verify the caller is an admin, using an anon-scoped client that forwards
    //    the caller's JWT. This runs BEFORE any user creation.
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })

    const {
      data: { user },
    } = await anon.auth.getUser()
    if (!user) {
      return json({ ok: false, error: 'Invalid or expired session' }, 401)
    }

    const { data: profile, error: profileError } = await anon
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profileError || !profile || profile.role !== 'admin') {
      return json({ ok: false, error: 'Admin access required' }, 403)
    }

    // 4. Parse + validate the request body.
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return json({ ok: false, error: 'Invalid JSON body' }, 400)
    }

    const full_name = typeof body.full_name === 'string' ? body.full_name.trim() : ''
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const unit_number =
      typeof body.unit_number === 'string' ? body.unit_number.trim() : null
    let employment_type =
      typeof body.employment_type === 'string' && body.employment_type
        ? body.employment_type
        : 'staff'

    if (!email || !password || !full_name) {
      return json(
        { ok: false, error: 'full_name, email and password are required' },
        400,
      )
    }
    if (employment_type !== 'staff' && employment_type !== 'contractor') {
      return json(
        { ok: false, error: "employment_type must be 'staff' or 'contractor'" },
        400,
      )
    }

    // 5. Create the auth user with the service-role admin client. The trigger
    //    handle_new_user() creates the profiles row from user_metadata.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name,
        unit_number,
        role: 'driver',
        employment_type,
      },
    })

    if (error) {
      // Surface a clean message (e.g. duplicate email); never the service key.
      return json({ ok: false, error: error.message }, 400)
    }

    return json({ ok: true, user_id: data.user.id }, 200)
  } catch (e) {
    return json(
      { ok: false, error: e instanceof Error ? e.message : 'Unexpected error' },
      500,
    )
  }
})
