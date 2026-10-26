-- Discord (Bot) channels can show one of the server's custom emojis per lock level (1-7) in
-- lock-gated notifications. JSON keyed by level: {"5":{"id":"…","name":"L5","animated":false}},
-- or null for none — checked against Discord when saved (src/lib/channels.ts).
-- Apply with: wrangler d1 migrations apply wme-requests

ALTER TABLE notification_channels ADD COLUMN discord_lock_emojis TEXT;
