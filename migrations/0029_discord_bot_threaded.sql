-- Discord (Bot) channels can optionally thread consecutive requests from the same submitter on
-- the same UTC day, like slack_threaded. Reuses last_thread_submitted_by/last_thread_ts/
-- last_thread_day — for discord_bot, last_thread_ts holds the id of the message the thread hangs
-- off (Discord gives a thread started from a message that same id).
-- Apply with: wrangler d1 migrations apply wme-requests

ALTER TABLE notification_channels ADD COLUMN discord_threaded INTEGER NOT NULL DEFAULT 0;
