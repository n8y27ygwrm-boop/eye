-- Add next_action column to clients table for follow-up workflow
ALTER TABLE public.clients
ADD COLUMN IF NOT EXISTS next_action text;
