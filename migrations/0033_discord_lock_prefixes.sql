-- Discord (webhook) channels can set a custom prefix per lock level, replacing the channel's
-- general custom prefix for lock-gated requests at that level. JSON: {"5":"<@&123> L5 {country_code}"},
-- null for none.
-- Apply with: wrangler d1 migrations apply wme-requests

ALTER TABLE notification_channels ADD COLUMN discord_lock_prefixes TEXT;
