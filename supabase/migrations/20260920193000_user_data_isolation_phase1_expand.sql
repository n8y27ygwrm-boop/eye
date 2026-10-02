-- Phase 1 Migration: Expand and Backfill User Data Isolation
-- Safe for live application deployment: adds nullable column, backfills data, sets default, FKs, and indexes.
-- Does NOT enforce NOT NULL or drop/replace existing RLS policies yet.

-- 1. Add owner_user_id UUID NULLABLE with DEFAULT auth.uid()
ALTER TABLE public.clients
ADD COLUMN IF NOT EXISTS owner_user_id uuid DEFAULT auth.uid();

ALTER TABLE public.visits
ADD COLUMN IF NOT EXISTS owner_user_id uuid DEFAULT auth.uid();

ALTER TABLE public.ai_reminders
ADD COLUMN IF NOT EXISTS owner_user_id uuid DEFAULT auth.uid();

-- 2. Backfill all existing rows to primary owner: a1026b88-6a25-4548-a055-cf12ea436bf8
UPDATE public.clients
SET owner_user_id = 'a1026b88-6a25-4548-a055-cf12ea436bf8'
WHERE owner_user_id IS NULL;

UPDATE public.visits
SET owner_user_id = 'a1026b88-6a25-4548-a055-cf12ea436bf8'
WHERE owner_user_id IS NULL;

UPDATE public.ai_reminders
SET owner_user_id = 'a1026b88-6a25-4548-a055-cf12ea436bf8'
WHERE owner_user_id IS NULL;

-- 3. Add foreign key constraints to auth.users(id) with ON DELETE RESTRICT
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_owner_user_id_fkey'
  ) THEN
    ALTER TABLE public.clients
    ADD CONSTRAINT clients_owner_user_id_fkey
    FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'visits_owner_user_id_fkey'
  ) THEN
    ALTER TABLE public.visits
    ADD CONSTRAINT visits_owner_user_id_fkey
    FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_reminders_owner_user_id_fkey'
  ) THEN
    ALTER TABLE public.ai_reminders
    ADD CONSTRAINT ai_reminders_owner_user_id_fkey
    FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- 4. Add sensible indexes on owner_user_id and key access patterns
CREATE INDEX IF NOT EXISTS idx_clients_owner_user_id ON public.clients(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_visits_owner_user_id ON public.visits(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_visits_owner_date ON public.visits(owner_user_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_ai_reminders_owner_user_id ON public.ai_reminders(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_owner_dismissed ON public.ai_reminders(owner_user_id, is_dismissed);

-- 5. Explicitly ENABLE ROW LEVEL SECURITY on all three tables
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_reminders ENABLE ROW LEVEL SECURITY;
