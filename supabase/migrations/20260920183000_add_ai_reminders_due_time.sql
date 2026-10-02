-- Add due_time column to ai_reminders table for explicit reminder time support
ALTER TABLE public.ai_reminders
ADD COLUMN IF NOT EXISTS due_time TIME;
