-- Phase 67 — capture qualification run failures on the brand row.
--
-- Previously the qualification orchestrator silently flipped
-- brands.qualification_state='error' without preserving the underlying
-- Postgres / network / LLM message. The new qualification_error column
-- holds a truncated copy of the failure text so the brand-page UI can
-- show the analyst what actually broke instead of the generic
-- "Run failed." fallback.
--
-- Already applied to prod via Supabase MCP — this file checks the change
-- into source control. IF NOT EXISTS keeps the replay idempotent.

ALTER TABLE brands ADD COLUMN IF NOT EXISTS qualification_error TEXT;
