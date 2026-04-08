-- PaddockPay Database Schema
-- Run this entire block in Supabase SQL Editor
-- Expected result: "Success. No rows returned"

-- Extensions
create extension if not exists "uuid-ossp";
create extension if not exists pg_cron;

-- PROFILES
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text not null,
  email text not null,
  role text not null check (role in ('admin', 'worker', 'both')),
  business_name text,
  abn text,
  subscription_status text not null default 'trial'
    check (subscription_status in ('trial', 'active', 'cancelled', 'expired')),
  trial_ends_at timestamptz not null default (now() + interval '7 days'),
  trial_extended boolean not null default false,
  stripe_customer_id text,
  xero_tenant_id text,
  xero_access_token_encrypted text,
  xero_refresh_token_encrypted text,
  xero_token_expiry timestamptz,
  xero_org_name text,
  statement_cc_email text,
  monthly_auto_send boolean not null default true,
  onboarding_completed boolean not null default false,
  onboarding_step int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- EMPLOYER-WORKER LINKS
create table public.employer_worker_links (
  id uuid default uuid_generate_v4() primary key,
  admin_id uuid not null references public.profiles(id) on delete cascade,
  worker_id uuid not null references public.profiles(id) on delete cascade,
  day_rate numeric(10,2) not null check (day_rate > 0),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'inactive')),
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique(admin_id, worker_id)
);

-- LABOUR DAYS
create table public.labour_days (
  id uuid default uuid_generate_v4() primary key,
  worker_id uuid not null references public.profiles(id) on delete cascade,
  admin_id uuid not null references public.profiles(id) on delete cascade,
  day_key text not null,
  day_type text not null check (day_type in ('full', 'half')),
  notes text check (char_length(notes) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(worker_id, admin_id, day_key)
);

-- MONTHLY STATEMENTS
create table public.monthly_statements (
  id uuid default uuid_generate_v4() primary key,
  worker_id uuid not null references public.profiles(id) on delete cascade,
  admin_id uuid not null references public.profiles(id) on delete cascade,
  month int not null check (month between 1 and 12),
  year int not null check (year >= 2024),
  full_days int not null default 0,
  half_days int not null default 0,
  total_days numeric(6,1) not null default 0,
  day_rate numeric(10,2) not null,
  total_amount numeric(10,2) not null,
  xero_invoice_id text,
  xero_invoice_number text,
  xero_invoice_url text,
  email_sent_to text,
  sent_at timestamptz,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'paid', 'void')),
  day_breakdown jsonb,
  created_at timestamptz not null default now(),
  unique(worker_id, admin_id, month, year)
);

-- SUBSCRIPTIONS
create table public.subscriptions (
  id uuid default uuid_generate_v4() primary key,
  admin_id uuid not null references public.profiles(id) on delete cascade unique,
  plan text not null default 'monthly' check (plan in ('monthly', 'yearly')),
  status text not null default 'trial'
    check (status in ('trial', 'active', 'cancelled', 'expired')),
  stripe_subscription_id text,
  stripe_price_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- INVITATIONS
create table public.invitations (
  id uuid default uuid_generate_v4() primary key,
  admin_id uuid not null references public.profiles(id) on delete cascade,
  invited_email text not null,
  token uuid not null default uuid_generate_v4() unique,
  day_rate numeric(10,2) not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'expired')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

-- AUDIT LOG
create table public.audit_log (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  table_name text not null,
  record_id text,
  old_value jsonb,
  new_value jsonb,
  performed_by_role text not null check (performed_by_role in ('admin', 'worker')),
  ip_address text,
  created_at timestamptz not null default now()
);

-- OFFLINE SYNC QUEUE (client-side IndexedDB — schema documented here for reference)
-- IndexedDB store: 'sync_queue'
-- Fields: id (auto), action ('upsert'|'delete'), table_name, payload (json), created_at, retry_count
-- This is implemented in the frontend JavaScript, not in Supabase

-- UPDATED_AT TRIGGER
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.handle_updated_at();

create trigger labour_days_updated_at
  before update on public.labour_days
  for each row execute function public.handle_updated_at();

create trigger subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.handle_updated_at();

-- AUTO-CREATE PROFILE ON SIGNUP
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'role', 'worker')
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ROW LEVEL SECURITY
alter table public.profiles enable row level security;
alter table public.employer_worker_links enable row level security;
alter table public.labour_days enable row level security;
alter table public.monthly_statements enable row level security;
alter table public.subscriptions enable row level security;
alter table public.invitations enable row level security;
alter table public.audit_log enable row level security;

-- PROFILES POLICIES
create policy "Users can view own profile"
  on public.profiles for select using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

create policy "Admins can view linked worker profiles"
  on public.profiles for select using (
    exists (
      select 1 from public.employer_worker_links
      where admin_id = auth.uid()
      and worker_id = profiles.id
      and status = 'active'
    )
  );

-- EMPLOYER WORKER LINKS POLICIES
create policy "Admins can manage their links"
  on public.employer_worker_links for all using (admin_id = auth.uid());

create policy "Workers can view their links"
  on public.employer_worker_links for select using (worker_id = auth.uid());

-- LABOUR DAYS POLICIES
create policy "Workers can manage own days"
  on public.labour_days for all using (worker_id = auth.uid());

create policy "Admins can view linked worker days"
  on public.labour_days for select using (admin_id = auth.uid());

create policy "Admins can insert worker days (backfill)"
  on public.labour_days for insert with check (admin_id = auth.uid());

create policy "Admins can update worker days"
  on public.labour_days for update using (admin_id = auth.uid());

-- MONTHLY STATEMENTS POLICIES
create policy "Admins can manage statements"
  on public.monthly_statements for all using (admin_id = auth.uid());

create policy "Workers can view own statements"
  on public.monthly_statements for select using (worker_id = auth.uid());

-- SUBSCRIPTIONS POLICIES
create policy "Admins can manage own subscription"
  on public.subscriptions for all using (admin_id = auth.uid());

-- INVITATIONS POLICIES
create policy "Admins can manage invitations"
  on public.invitations for all using (admin_id = auth.uid());

create policy "Anyone can read invitation by token"
  on public.invitations for select using (true);

-- AUDIT LOG POLICIES
create policy "Users can insert own audit entries"
  on public.audit_log for insert with check (user_id = auth.uid());

create policy "Admins can view their account audit log"
  on public.audit_log for select using (
    user_id = auth.uid()
    or exists (
      select 1 from public.employer_worker_links
      where admin_id = auth.uid()
      and worker_id = audit_log.user_id
      and status = 'active'
    )
  );

-- VERIFY RLS IS ACTIVE
-- Run this after setup to confirm all tables have RLS enabled:
-- select tablename, rowsecurity from pg_tables where schemaname = 'public';
-- All tables should show rowsecurity = true (t)
