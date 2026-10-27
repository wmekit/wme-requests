import type { RequestType } from './types'

// Pure message formatting for every notification platform — no I/O, so the senders in
// ./notifications and the channel form's preview (src/components/ChannelPreview.tsx) build
// exactly the same text and payloads.

export interface NotificationMessage {
  requestId: number | null
  title: string
  color: number
  permalink: string
  lockLevel: number | null
  notes: string | null
  submittedBy: string | null
  editorRank: number | null
  screenshotUrl: string | null
}

// Variables available inside a channel's custom_prefix template, e.g. "L{lock_level}{country_code}".
export type PrefixVars = Record<string, string>

// A custom emoji in a Discord server, as stored in a channel's discord_lock_emojis.
export interface GuildEmoji {
  id: string
  name: string
  animated: boolean
}

// Same as LOCK_GATED_TYPES in ./requests — downlock/uplock and PUR requests carry a lock
// level, imagery requests don't.
export const LOCK_GATED_TYPES = new Set<RequestType>(['downlock', 'uplock', 'accept_pur', 'decline_pur'])

export const TYPE_META: Record<RequestType, { label: string; color: number }> = {
  downlock: { label: 'Downlock Request', color: 0xe74c3c },
  uplock: { label: 'Uplock Request', color: 0x9b59b6 },
  imagery: { label: 'Imagery Request', color: 0x3498db },
  accept_pur: { label: 'Accept PUR Request', color: 0x2ecc71 },
  decline_pur: { label: 'Decline PUR Request', color: 0xf39c12 },
}

export function userProfileUrl(username: string) {
  return `https://www.waze.com/user/editor/${encodeURIComponent(username)}`
}

export function applyPrefixTemplate(template: string, vars: PrefixVars) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match)
}

/** How a custom emoji is written in message text, e.g. `<:L5:123>` or `<a:L5:123>`. */
export function emojiMention(e: GuildEmoji) {
  return `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`
}

function rankSuffix(msg: NotificationMessage) {
  return msg.editorRank != null ? ` (Rank ${msg.editorRank})` : ''
}

// Plain (unescaped) permalink/lock-level/notes lines shared by Discord and Telegram —
// the submitter line is built separately by each platform since it includes a link.
export function bodyLines(msg: NotificationMessage) {
  const lines = [`Permalink: ${msg.permalink}`]
  if (msg.lockLevel != null) lines.push(`Lock Level: ${msg.lockLevel}`)
  if (msg.notes) lines.push(`Notes: ${msg.notes}`)
  return lines
}

export function hexColor(color: number) {
  return `#${color.toString(16).padStart(6, '0')}`
}

// Shared Block Kit builder for both plain and threaded Slack channels — a colored side bar
// via a legacy "attachment" wrapping modern blocks, with fields laid out in a grid. (Incoming
// webhooks can't open a true modal, which requires a trigger_id from a live user interaction.)
export function buildSlackPayload(msg: NotificationMessage, prefix: string | null) {
  const fields: Array<{ type: 'mrkdwn'; text: string }> = [
    { type: 'mrkdwn', text: `*Permalink:*\n<${msg.permalink}|Open>` },
  ]
  if (msg.lockLevel != null) fields.push({ type: 'mrkdwn', text: `*Lock Level:*\n${msg.lockLevel}` })
  if (msg.submittedBy) {
    fields.push({
      type: 'mrkdwn',
      text: `*Submitted by:*\n<${userProfileUrl(msg.submittedBy)}|${msg.submittedBy}>${rankSuffix(msg)}`,
    })
  }

  const blocks: SlackBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${msg.title}*` } },
    { type: 'section', fields },
  ]
  if (msg.notes) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Notes:*\n${msg.notes}` } })
  }
  if (msg.screenshotUrl) {
    blocks.push({ type: 'image', image_url: msg.screenshotUrl, alt_text: 'Map viewport screenshot' })
  }

  return {
    // Fallback/notification-preview text — also where the prefix's @mentions actually notify,
    // since attachment blocks aren't reliably parsed for that the same way.
    text: prefix || msg.title,
    attachments: [{ color: hexColor(msg.color), blocks }],
  }
}

export type SlackBlock =
  | { type: 'section'; text?: { type: 'mrkdwn'; text: string }; fields?: Array<{ type: 'mrkdwn'; text: string }> }
  | { type: 'image'; image_url: string; alt_text: string }

// Shared by the webhook and bot Discord senders, so both post identical messages. The bot sender
// can pass the lock level's custom emoji, shown in place of the level number in the embed.
export function buildDiscordPayload(msg: NotificationMessage, prefix: string | null, lockEmoji?: string | null) {
  const lines = bodyLines(msg)
  if (lockEmoji && msg.lockLevel != null) {
    const i = lines.indexOf(`Lock Level: ${msg.lockLevel}`)
    if (i >= 0) lines[i] = `Lock Level: ${lockEmoji}`
  }
  if (msg.submittedBy) lines.push(`Submitted by: [${msg.submittedBy}](${userProfileUrl(msg.submittedBy)})${rankSuffix(msg)}`)
  return {
    content: prefix || undefined,
    embeds: [
      {
        title: msg.title,
        description: lines.join('\n'),
        color: msg.color,
        timestamp: new Date().toISOString(),
        ...(msg.screenshotUrl ? { image: { url: msg.screenshotUrl } } : {}),
      },
    ],
  }
}

/** A channel's custom emoji for a lock level (from stored discord_lock_emojis JSON) as message text, or null. */
export function discordLockEmoji(lockEmojis: string | null, lockLevel: number | null) {
  if (lockLevel == null || !lockEmojis) return null
  try {
    const emoji = (JSON.parse(lockEmojis) as Record<string, GuildEmoji>)[String(lockLevel)]
    return emoji ? emojiMention(emoji) : null
  } catch {
    return null
  }
}

/**
 * A Discord (Bot) message's content: role pings and the lock level's emoji share the first line,
 * ahead of the prefix.
 */
export function discordBotContent(roleIds: string | null, lockEmoji: string | null, prefix: string | null) {
  const roleMentions = (roleIds?.split(',') ?? []).map((r) => `<@&${r}>`).join(' ')
  return [[roleMentions, lockEmoji].filter(Boolean).join(' '), prefix].filter(Boolean).join('\n') || null
}

// Name for a thread or forum post the bot creates: the channel's discord_thread_title template
// when set (same variables as the prefix, plus {date}), else `fallback`. Discord names are one
// line of up to 100 characters; pasted Unicode emoji work, custom <:emoji:id> ones show as text.
export function discordThreadName(template: string | null, vars: PrefixVars, today: string, fallback: string) {
  const custom = template
    ? applyPrefixTemplate(template, { ...vars, date: today }).replace(/\s+/g, ' ').trim()
    : ''
  // Cut by code point so an emoji isn't split in half.
  return Array.from(custom || fallback).slice(0, 100).join('')
}

// Google Chat's incoming webhook takes a plain { text } body — it supports a small markup
// subset (*bold*, <url|label> links) but nothing like Slack's block/attachment layout.
export function buildGoogleChatText(msg: NotificationMessage, prefix: string | null) {
  const lines = [`*${msg.title}*`]
  if (prefix) lines.push(prefix)
  lines.push(`<${msg.permalink}|Open>`)
  if (msg.lockLevel != null) lines.push(`Lock Level: ${msg.lockLevel}`)
  if (msg.submittedBy) lines.push(`Submitted by: <${userProfileUrl(msg.submittedBy)}|${msg.submittedBy}>${rankSuffix(msg)}`)
  if (msg.notes) lines.push(`Notes: ${msg.notes}`)
  return lines.join('\n')
}

/** Title and plain-text body for push-style platforms (ntfy, Gotify). */
export function buildPlainNotification(msg: NotificationMessage, prefix: string | null) {
  const lines = bodyLines(msg)
  if (msg.submittedBy) lines.push(`Submitted by: ${msg.submittedBy}${rankSuffix(msg)}`)
  return { title: prefix ? `${prefix} ${msg.title}` : msg.title, message: lines.join('\n') }
}

export function escapeMarkdown(text: string) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')
}

// Telegram's MarkdownV2 link destinations only need ')' and '\' escaped — escaping
// the whole URL with escapeMarkdown would also mangle '/' and ':' and break the link.
function escapeTelegramLinkUrl(url: string) {
  return url.replace(/([)\\])/g, String.raw`\$1`)
}

/** Telegram MarkdownV2 message text (or photo caption). */
export function buildTelegramText(msg: NotificationMessage, prefix: string | null) {
  const prefixLine = prefix ? `${escapeMarkdown(prefix)}\n` : ''
  const rank = msg.editorRank != null ? escapeMarkdown(rankSuffix(msg)) : ''
  const lines = bodyLines(msg).map(escapeMarkdown)
  if (msg.submittedBy) {
    lines.push(
      `Submitted by: [${escapeMarkdown(msg.submittedBy)}](${escapeTelegramLinkUrl(userProfileUrl(msg.submittedBy))})${rank}`,
    )
  }
  return `*${escapeMarkdown(msg.title)}*\n${prefixLine}${lines.join('\n')}`
}

export function escapeHtml(text: string) {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(text).replace(/[&<>"']/g, (c) => entities[c])
}

export function buildEmail(msg: NotificationMessage, prefix: string | null) {
  const rank = rankSuffix(msg)
  const lines = bodyLines(msg)
  if (msg.submittedBy) lines.push(`Submitted by: ${msg.submittedBy}${rank} — ${userProfileUrl(msg.submittedBy)}`)
  const html = [
    prefix ? `<p style="color:#666;margin:0 0 12px">${escapeHtml(prefix)}</p>` : '',
    `<h2 style="margin:0 0 12px">${escapeHtml(msg.title)}</h2>`,
    `<p><a href="${escapeHtml(msg.permalink)}">${escapeHtml(msg.permalink)}</a></p>`,
    msg.lockLevel != null ? `<p><strong>Lock Level:</strong> ${msg.lockLevel}</p>` : '',
    msg.submittedBy
      ? `<p><strong>Submitted by:</strong> <a href="${escapeHtml(userProfileUrl(msg.submittedBy))}">${escapeHtml(msg.submittedBy)}</a>${escapeHtml(rank)}</p>`
      : '',
    msg.notes ? `<p><strong>Notes:</strong><br>${escapeHtml(msg.notes).replaceAll('\n', '<br>')}</p>` : '',
    msg.screenshotUrl
      ? `<p><img src="${escapeHtml(msg.screenshotUrl)}" alt="Map viewport screenshot" style="max-width:100%"></p>`
      : '',
  ]
  return {
    subject: prefix ? `[${prefix}] ${msg.title}` : msg.title,
    textBody: lines.join('\n'),
    htmlBody: html.filter(Boolean).join('\n'),
  }
}

// Plain structured JSON for arbitrary custom integrations — no platform-specific
// formatting, unlike the Slack/Discord/Telegram senders.
export function buildWebhookBody(msg: NotificationMessage, prefix: string | null) {
  return {
    title: msg.title,
    prefix,
    permalink: msg.permalink,
    lock_level: msg.lockLevel,
    notes: msg.notes,
    submitted_by: msg.submittedBy,
    submitted_by_url: msg.submittedBy ? userProfileUrl(msg.submittedBy) : null,
    editor_rank: msg.editorRank,
    screenshot_url: msg.screenshotUrl,
  }
}

export const GOOGLE_SHEET_HEADERS = [
  'Timestamp',
  'Type',
  'Country',
  'Country Code',
  'Region',
  'Region Code',
  'Permalink',
  'Lock Level',
  'Editor Rank',
  'Notes',
  'Submitted By',
  'Screenshot URL',
]

export function buildSheetRow(msg: NotificationMessage, vars: PrefixVars, timestamp: string) {
  return [
    timestamp,
    vars.type,
    vars.country_name,
    vars.country_code,
    vars.region_name,
    vars.region_code,
    msg.permalink,
    msg.lockLevel ?? '',
    msg.editorRank ?? '',
    msg.notes ?? '',
    msg.submittedBy ?? '',
    msg.screenshotUrl ?? '',
  ]
}
