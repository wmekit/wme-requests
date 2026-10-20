-- Discord (Bot) channels can ping chosen roles in every notification. Comma-separated role ids
-- from the channel's server, checked against Discord when saved (src/lib/channels.ts).
-- Apply with: wrangler d1 migrations apply wme-requests

ALTER TABLE notification_channels ADD COLUMN discord_role_ids TEXT;
