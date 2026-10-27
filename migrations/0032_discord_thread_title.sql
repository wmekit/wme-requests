-- Discord (Bot) channels can set a custom title template for the threads and forum posts they
-- create, using the same {variables} as the custom prefix (plus {date}). Null for the default.
-- Apply with: wrangler d1 migrations apply wme-requests

ALTER TABLE notification_channels ADD COLUMN discord_thread_title TEXT;
