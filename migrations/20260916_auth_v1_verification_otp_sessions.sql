-- ============================================================================
-- Agently V1 authentication: email verification, login OTP, real sessions.
--
-- WHY THIS EXISTS
--
-- Three things were true before this migration and all three are problems:
--
--   1. Nothing proved a person owned the email address they signed up with.
--      `users` had no verified flag at all, so there was nowhere to record it
--      even if we had checked.
--
--   2. Sessions were stateless JWTs with a 30-day expiry and no server-side
--      record. POST /api/auth/logout could not revoke anything — it cleared a
--      cache and returned success. A leaked token stayed valid for 30 days and
--      changing your password did not stop it.
--
--   3. POST /api/auth/magic-link returned the sign-in token in its own
--      response body, in production, and /magic-link/verify auto-created an
--      organization for any unknown address. Anyone could sign in as anyone,
--      or manufacture tenants, without access to a mailbox. The sign-in half
--      of that flow is being removed in the same change as this migration.
--
-- Additive only: new tables, and new columns with defaults. Nothing is dropped
-- and no existing column changes type or nullability, so a deploy running the
-- previous code against this schema keeps working.
--
-- EXISTING ACCOUNTS ARE GRANDFATHERED. Every user that exists when this runs
-- is marked verified. They were created before we asked, and locking twenty
-- real accounts out of a workspace to enforce a rule introduced today would be
-- punishing people for our own omission. New accounts must verify.
-- ============================================================================

begin;

-- ── users: verification + session invalidation ─────────────────────────────

alter table public.users
  add column if not exists email_verified      boolean     not null default false,
  add column if not exists email_verified_at   timestamptz,
  add column if not exists password_changed_at timestamptz,
  -- Bumped to invalidate every outstanding session for this user at once
  -- (password reset, "sign out everywhere", admin action). Cheaper and more
  -- reliable than hunting individual session rows, and it is carried in the
  -- JWT so a mismatch is caught without a second lookup.
  add column if not exists session_epoch       integer     not null default 0;

-- Grandfather everyone who already had an account. See the header.
update public.users
   set email_verified    = true,
       email_verified_at = coalesce(email_verified_at, created_at, now())
 where email_verified is not true;

comment on column public.users.email_verified is
  'Proven ownership of the email address. Set by POST /api/auth/verify-email. Accounts predating the V1 auth migration were grandfathered to true.';
comment on column public.users.session_epoch is
  'Incremented to revoke every outstanding session for this user. The value is embedded in each session JWT as "sev" and compared on every request.';

-- ── auth_codes: ONE table, TWO deliberately separate purposes ──────────────
--
-- `purpose` is what keeps email verification and login OTP from being the same
-- mechanism wearing two hats. A row minted to prove ownership of a new address
-- can never satisfy a login challenge, and vice versa, because every lookup
-- filters on purpose. Sharing the storage keeps expiry, hashing, attempt
-- limits and cleanup in one place; sharing the *semantics* would be the bug.
--
-- Codes are stored as SHA-256 hashes. A code is a bearer credential for the
-- seconds it lives, and a database backup or an over-broad SELECT should not
-- hand someone a working one.

create table if not exists public.auth_codes (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid references public.users(id) on delete cascade,
  email         text        not null,
  purpose       text        not null check (purpose in ('email_verify', 'login_otp')),
  code_hash     text        not null,
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  attempts      integer     not null default 0,
  max_attempts  integer     not null default 5,
  created_at    timestamptz not null default now(),
  request_ip    text,
  user_agent    text
);

create index if not exists auth_codes_lookup_idx
  on public.auth_codes (email, purpose, consumed_at, expires_at desc);
create index if not exists auth_codes_user_idx
  on public.auth_codes (user_id, purpose);
-- Supports the resend-cooldown and per-hour send-cap queries.
create index if not exists auth_codes_recent_idx
  on public.auth_codes (email, purpose, created_at desc);

comment on table public.auth_codes is
  'Short-lived one-time codes. purpose=email_verify proves ownership of an address at signup; purpose=login_otp is a second factor for an existing account. The two must never be interchangeable.';
comment on column public.auth_codes.code_hash is
  'SHA-256 of the code. The plaintext code exists only in the email and in the request that verifies it.';

-- ── auth_sessions: server-authoritative sessions ───────────────────────────
--
-- Without this table "log out" is a client-side lie and an idle timeout is a
-- setTimeout. The server now owns both.
--
--   absolute_expires_at  hard ceiling, set at sign-in, never extended
--   last_seen_at         slides forward on use; idle timeout measures from it
--   revoked_at           set by logout, password reset, or a security event

create table if not exists public.auth_sessions (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid        not null references public.users(id) on delete cascade,
  organization_id     uuid        references public.organizations(id) on delete cascade,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  absolute_expires_at timestamptz not null,
  revoked_at          timestamptz,
  revoked_reason      text,
  client              text,
  request_ip          text,
  user_agent          text
);

create index if not exists auth_sessions_user_idx
  on public.auth_sessions (user_id, revoked_at);
create index if not exists auth_sessions_sweep_idx
  on public.auth_sessions (absolute_expires_at)
  where revoked_at is null;

comment on table public.auth_sessions is
  'One row per authenticated session. The session JWT carries this row id as "sid"; middleware/auth.js rejects a token whose row is missing, revoked, past its absolute expiry, or idle beyond the configured window.';
comment on column public.auth_sessions.last_seen_at is
  'Updated at most once per AUTH_SESSION_TOUCH_INTERVAL_MINUTES so a busy workspace does not write on every request.';

-- ── auth_rate_limits: durable counters ─────────────────────────────────────
--
-- The in-memory Map used elsewhere in this codebase resets on every container
-- restart and is per-instance. For credential endpoints that is the difference
-- between a real limit and a speed bump, so these counters live in the
-- database where a restart and a second instance both see the same state.

create table if not exists public.auth_rate_limits (
  bucket       text        primary key,
  count        integer     not null default 0,
  window_start timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists auth_rate_limits_sweep_idx
  on public.auth_rate_limits (window_start);

comment on table public.auth_rate_limits is
  'Fixed-window counters for authentication endpoints, keyed by a bucket string such as "login:ip:1.2.3.4" or "otp_send:email:a@b.com".';

-- Atomic increment. Doing this in application code needs a read then a write,
-- and two requests arriving together both read the old value — which is how a
-- "5 per hour" limit quietly becomes "however many arrive at once".
create or replace function public.auth_rate_limit_hit(
  p_bucket       text,
  p_window_secs  integer,
  p_limit        integer
) returns table (allowed boolean, current_count integer, retry_after_secs integer)
language plpgsql
as $$
declare
  v_now      timestamptz := now();
  v_start    timestamptz;
  v_count    integer;
begin
  insert into public.auth_rate_limits (bucket, count, window_start, updated_at)
       values (p_bucket, 1, v_now, v_now)
  on conflict (bucket) do update
        set count = case
                      when public.auth_rate_limits.window_start < v_now - make_interval(secs => p_window_secs)
                      then 1
                      else public.auth_rate_limits.count + 1
                    end,
            window_start = case
                      when public.auth_rate_limits.window_start < v_now - make_interval(secs => p_window_secs)
                      then v_now
                      else public.auth_rate_limits.window_start
                    end,
            updated_at = v_now
    returning public.auth_rate_limits.count, public.auth_rate_limits.window_start
    into v_count, v_start;

  return query
    select
      v_count <= p_limit,
      v_count,
      greatest(0, p_window_secs - extract(epoch from (v_now - v_start))::integer);
end;
$$;

comment on function public.auth_rate_limit_hit is
  'Records one hit against a fixed window and reports whether it is allowed. The upsert is atomic so concurrent requests cannot both read a stale count.';

-- ── Row level security ────────────────────────────────────────────────────
--
-- Deny-all, matching users / magic_link_tokens / password_reset_tokens.
--
-- This is not theoretical. The web client ships a Supabase ANON key so it can
-- subscribe to Realtime, and that key is readable by anyone who opens the
-- bundle. With RLS off, anon could SELECT auth_codes and read every live code
-- hash and the address it belongs to. No policies are added: the API reaches
-- these tables with the service role, which bypasses RLS, and nothing else has
-- any business reading them.

alter table public.auth_codes       enable row level security;
alter table public.auth_sessions    enable row level security;
alter table public.auth_rate_limits enable row level security;

commit;
