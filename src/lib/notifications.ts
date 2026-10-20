import { dbAll, dbRun, type RequestType } from './db'
import { appendSheetRow } from './google-sheets'
import { screenshotUrl } from './screenshots'
import { resolveGoogleCredential, resolveEmailCredential } from './credentials'
import { sendEmail as dispatchEmail } from './email/send-email'
import { sendPush } from './push'
import {
  discordApi,
  DiscordApiError,
  UNKNOWN_CHANNEL,
  interactionsConfigured,
  requestButtons,
} from './discord-bot'
import { audiencePushSubscriptions, deleteSubscriptionById, type PushSubscriptionRow } from './subscriptions'

// Same as LOCK_GATED_TYPES in ./requests — downlock/uplock and PUR requests carry a lock
// level, imagery requests don't.
const LOCK_GATED_TYPES = new Set<RequestType>(['downlock', 'uplock', 'accept_pur', 'decline_pur'])

export interface NotificationChannel {
  id: number
  country_id: number
  region_id: number | null
  label: string
  platform:
    | 'slack'
    | 'slack_threaded'
    | 'discord'
    | 'discord_bot'
    | 'telegram'
    | 'email'
    | 'webhook'
    | 'google_sheets'
    | 'google_chat'
    | 'ntfy'
    | 'gotify'
  event_type: 'global' | RequestType
  webhook_url: string | null
  bot_token: string | null
  chat_id: string | null
  custom_prefix: string | null
  email_to: string | null
  discord_forum: number
  spreadsheet_id: string | null
  sheet_name: string | null
  google_credential_id: number | null
  email_credential_id: number | null
  last_thread_submitted_by: string | null
  last_thread_ts: string | null
  last_thread_day: string | null
  discord_guild_id: string | null
  discord_channel_id: string | null
  discord_threaded: number
}

export interface RequestRow {
  id: number
  country_id: number
  region_id: number | null
  type: RequestType
  permalink: string
  lock_level: number | null
  editor_rank: number | null
  notes: string | null
  submitted_by: string | null
  screenshot_key: string | null
}

function userProfileUrl(username: string) {
  return `https://www.waze.com/user/editor/${encodeURIComponent(username)}`
}

// Variables available inside a channel's custom_prefix template, e.g. "L{lock_level}{country_code}".
type PrefixVars = Record<string, string>

function applyPrefixTemplate(template: string, vars: PrefixVars) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match)
}

const TYPE_META: Record<RequestType, { label: string; color: number }> = {
  downlock: { label: 'Downlock Request', color: 0xe74c3c },
  uplock: { label: 'Uplock Request', color: 0x9b59b6 },
  imagery: { label: 'Imagery Request', color: 0x3498db },
  accept_pur: { label: 'Accept PUR Request', color: 0x2ecc71 },
  decline_pur: { label: 'Decline PUR Request', color: 0xf39c12 },
}

function buildMessage(request: RequestRow, countryName: string, regionName: string | null) {
  const meta = TYPE_META[request.type]
  const place = regionName ? `${regionName}, ${countryName}` : countryName
  const title = `${meta.label} — ${place}`
  return {
    requestId: request.id as number | null,
    title,
    color: meta.color,
    permalink: request.permalink,
    lockLevel: LOCK_GATED_TYPES.has(request.type) ? request.lock_level : null,
    notes: request.notes,
    submittedBy: request.submitted_by,
    editorRank: request.editor_rank,
    screenshotUrl: screenshotUrl(request.screenshot_key),
  }
}

// Plain (unescaped) permalink/lock-level/notes lines shared by Discord and Telegram —
// the submitter line is built separately by each platform since it includes a link.
function bodyLines(msg: ReturnType<typeof buildMessage>) {
  const lines = [`Permalink: ${msg.permalink}`]
  if (msg.lockLevel != null) lines.push(`Lock Level: ${msg.lockLevel}`)
  if (msg.notes) lines.push(`Notes: ${msg.notes}`)
  return lines
}

function hexColor(color: number) {
  return `#${color.toString(16).padStart(6, '0')}`
}

// Shared Block Kit builder for both plain and threaded Slack channels — a colored side bar
// via a legacy "attachment" wrapping modern blocks, with fields laid out in a grid. (Incoming
// webhooks can't open a true modal, which requires a trigger_id from a live user interaction.)
function buildSlackPayload(msg: ReturnType<typeof buildMessage>, prefix: string | null) {
  const rankSuffix = msg.editorRank != null ? ` (Rank ${msg.editorRank})` : ''
  const fields: Array<{ type: 'mrkdwn'; text: string }> = [
    { type: 'mrkdwn', text: `*Permalink:*\n<${msg.permalink}|Open>` },
  ]
  if (msg.lockLevel != null) fields.push({ type: 'mrkdwn', text: `*Lock Level:*\n${msg.lockLevel}` })
  if (msg.submittedBy) {
    fields.push({
      type: 'mrkdwn',
      text: `*Submitted by:*\n<${userProfileUrl(msg.submittedBy)}|${msg.submittedBy}>${rankSuffix}`,
    })
  }

  const blocks: unknown[] = [
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

async function sendSlack(webhookUrl: string, msg: ReturnType<typeof buildMessage>, prefix: string | null) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSlackPayload(msg, prefix)),
  })
}

// Threads consecutive requests from the same submitter (same UTC calendar day) into one Slack
// thread instead of a new top-level message each time. Incoming webhooks have no way to do
// this — they don't return a message `ts` to reply against — so this uses chat.postMessage
// with a bot token instead, and persists the last message's ts/submitter/day on the channel
// row so the next request can decide whether to join it.
async function sendSlackThreaded(
  channel: NotificationChannel,
  msg: ReturnType<typeof buildMessage>,
  prefix: string | null,
) {
  const botToken = channel.bot_token
  const chatId = channel.chat_id
  if (!botToken || !chatId) throw new Error('Bot token and channel ID are required for slack_threaded')

  const today = new Date().toISOString().slice(0, 10)
  const threadTs =
    msg.submittedBy &&
    msg.submittedBy === channel.last_thread_submitted_by &&
    today === channel.last_thread_day
      ? channel.last_thread_ts
      : null

  const payload = buildSlackPayload(msg, prefix)
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botToken}` },
    body: JSON.stringify({ channel: chatId, ...payload, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  })
  const data = await res.json<{ ok: boolean; ts?: string; error?: string }>()
  if (!data.ok) throw new Error(`Slack API error: ${data.error || 'unknown'}`)

  await dbRun(
    `UPDATE notification_channels SET last_thread_submitted_by = ?, last_thread_ts = ?, last_thread_day = ? WHERE id = ?`,
    [msg.submittedBy || null, threadTs || data.ts || null, today, channel.id],
  )
}

// Shared by the webhook and bot Discord senders, so both post identical messages.
function buildDiscordPayload(msg: ReturnType<typeof buildMessage>, prefix: string | null) {
  const rankSuffix = msg.editorRank != null ? ` (Rank ${msg.editorRank})` : ''
  const lines = bodyLines(msg)
  if (msg.submittedBy) lines.push(`Submitted by: [${msg.submittedBy}](${userProfileUrl(msg.submittedBy)})${rankSuffix}`)
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

// Forum channels have no general message stream — every webhook post must create a new
// post (thread) via `thread_name`, capped at Discord's 100-character thread name limit.
async function sendDiscord(
  webhookUrl: string,
  msg: ReturnType<typeof buildMessage>,
  prefix: string | null,
  isForumThread: boolean,
) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...buildDiscordPayload(msg, prefix),
      ...(isForumThread ? { thread_name: (prefix || msg.title).slice(0, 100) } : {}),
    }),
  })
}

// Posts as this app's own bot (src/lib/discord-bot.ts). Unlike the webhook sender, failures
// throw with Discord's reason (e.g. the bot was removed from the server), which the Test button
// shows. allowed_mentions is explicit so mentions in the prefix still ping; forum channels get
// a new post per notification, same as the webhook sender.
//
// With discord_threaded set, consecutive requests from the same submitter (same UTC calendar day)
// go into one thread instead, like sendSlackThreaded: in a forum, as replies to the first
// request's post; in a text/announcement channel, in a thread started from the first request's
// message (created on the second request, so single requests don't leave empty threads behind).
// A thread started from a message shares its id, so last_thread_ts holding that message id is
// enough either way. Threaded channels' request messages also get Complete / Reject / Close
// thread buttons (src/lib/discord-interactions.ts).
async function sendDiscordBot(channel: NotificationChannel, msg: ReturnType<typeof buildMessage>, prefix: string | null) {
  if (!channel.discord_channel_id) throw new Error('No Discord channel configured for this channel')
  const message = {
    ...buildDiscordPayload(msg, prefix),
    allowed_mentions: { parse: ['users', 'roles', 'everyone'] },
    ...(channel.discord_threaded && msg.requestId != null && interactionsConfigured()
      ? { components: requestButtons(msg.requestId) }
      : {}),
  }
  const id = encodeURIComponent(channel.discord_channel_id)
  const isForum = !!channel.discord_forum

  const today = new Date().toISOString().slice(0, 10)
  const threadId =
    channel.discord_threaded &&
    msg.submittedBy &&
    msg.submittedBy === channel.last_thread_submitted_by &&
    today === channel.last_thread_day
      ? channel.last_thread_ts
      : null

  if (threadId) {
    const thread = encodeURIComponent(threadId)
    const reply = () => discordApi(`/channels/${thread}/messages`, { method: 'POST', body: JSON.stringify(message) })
    try {
      try {
        await reply()
      } catch (e) {
        if (isForum || !(e instanceof DiscordApiError) || e.code !== UNKNOWN_CHANNEL) throw e
        // No thread on the first request's message yet — start one, then reply in it.
        await discordApi(`/channels/${id}/messages/${thread}/threads`, {
          method: 'POST',
          body: JSON.stringify({ name: `Requests from ${msg.submittedBy} — ${today}`.slice(0, 100) }),
        })
        await reply()
      }
      return
    } catch (e) {
      // The thread (or its starter message) was deleted, it's locked, or the bot can't create
      // threads — fall back to a fresh top-level post, which starts a new chain.
      console.warn('Discord thread reply failed, posting a new message instead', e)
    }
  }

  const posted = isForum
    ? await discordApi<{ id: string }>(`/channels/${id}/threads`, {
        method: 'POST',
        body: JSON.stringify({ name: (prefix || msg.title).slice(0, 100), message }),
      })
    : await discordApi<{ id: string }>(`/channels/${id}/messages`, { method: 'POST', body: JSON.stringify(message) })

  if (channel.discord_threaded) {
    await dbRun(
      `UPDATE notification_channels SET last_thread_submitted_by = ?, last_thread_ts = ?, last_thread_day = ? WHERE id = ?`,
      [msg.submittedBy || null, posted.id, today, channel.id],
    )
  }
}

// Google Chat's incoming webhook takes a plain { text } body — it supports a small markup
// subset (*bold*, <url|label> links) but nothing like Slack's block/attachment layout.
async function sendGoogleChat(webhookUrl: string, msg: ReturnType<typeof buildMessage>, prefix: string | null) {
  const rankSuffix = msg.editorRank != null ? ` (Rank ${msg.editorRank})` : ''
  const lines = [`*${msg.title}*`]
  if (prefix) lines.push(prefix)
  lines.push(`<${msg.permalink}|Open>`)
  if (msg.lockLevel != null) lines.push(`Lock Level: ${msg.lockLevel}`)
  if (msg.submittedBy) lines.push(`Submitted by: <${userProfileUrl(msg.submittedBy)}|${msg.submittedBy}>${rankSuffix}`)
  if (msg.notes) lines.push(`Notes: ${msg.notes}`)

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: lines.join('\n') }),
  })
}

// ntfy's JSON publish endpoint lives at the server root, not the topic URL itself — posting
// straight to the topic URL with headers would work too, but title/message would need to be
// ASCII-safe (HTTP header values can't carry arbitrary Unicode), and request titles/notes
// often aren't (e.g. em dashes). The JSON endpoint sidesteps that entirely.
async function sendNtfy(topicUrl: string, token: string | null, msg: ReturnType<typeof buildMessage>, prefix: string | null) {
  const rankSuffix = msg.editorRank != null ? ` (Rank ${msg.editorRank})` : ''
  const lines = bodyLines(msg)
  if (msg.submittedBy) lines.push(`Submitted by: ${msg.submittedBy}${rankSuffix}`)

  const url = new URL(topicUrl)
  const topic = url.pathname.replace(/^\//, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  await fetch(url.origin, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      topic,
      title: prefix ? `${prefix} ${msg.title}` : msg.title,
      message: lines.join('\n'),
      click: msg.permalink,
      ...(msg.screenshotUrl ? { attach: msg.screenshotUrl } : {}),
    }),
  })
}

// Gotify's application token is passed as a query param, not a header.
async function sendGotify(serverUrl: string, token: string, msg: ReturnType<typeof buildMessage>, prefix: string | null) {
  const rankSuffix = msg.editorRank != null ? ` (Rank ${msg.editorRank})` : ''
  const lines = bodyLines(msg)
  if (msg.submittedBy) lines.push(`Submitted by: ${msg.submittedBy}${rankSuffix}`)

  const base = serverUrl.endsWith('/') ? serverUrl.slice(0, -1) : serverUrl
  await fetch(`${base}/message?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: prefix ? `${prefix} ${msg.title}` : msg.title,
      message: lines.join('\n'),
      priority: 5,
      extras: { 'client::notification': { click: { url: msg.permalink } } },
    }),
  })
}

function escapeMarkdown(text: string) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')
}

// Telegram's MarkdownV2 link destinations only need ')' and '\' escaped — escaping
// the whole URL with escapeMarkdown would also mangle '/' and ':' and break the link.
function escapeTelegramLinkUrl(url: string) {
  return url.replace(/([)\\])/g, String.raw`\$1`)
}

async function sendTelegram(botToken: string, chatId: string, msg: ReturnType<typeof buildMessage>, prefix: string | null) {
  const prefixLine = prefix ? `${escapeMarkdown(prefix)}\n` : ''
  const rankSuffix = msg.editorRank != null ? escapeMarkdown(` (Rank ${msg.editorRank})`) : ''
  const lines = bodyLines(msg).map(escapeMarkdown)
  if (msg.submittedBy) {
    lines.push(
      `Submitted by: [${escapeMarkdown(msg.submittedBy)}](${escapeTelegramLinkUrl(userProfileUrl(msg.submittedBy))})${rankSuffix}`,
    )
  }
  const text = `*${escapeMarkdown(msg.title)}*\n${prefixLine}${lines.join('\n')}`

  // sendPhoto's caption is capped at 1024 chars (vs sendMessage's 4096) — unlikely to
  // matter for these short messages, but if it's ever exceeded Telegram rejects the
  // whole request rather than truncating, so this isn't silently lossy.
  if (msg.screenshotUrl) {
    await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: msg.screenshotUrl, caption: text, parse_mode: 'MarkdownV2' }),
    })
    return
  }

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'MarkdownV2' }),
  })
}

function escapeHtml(text: string) {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(text).replace(/[&<>"']/g, (c) => entities[c])
}

function buildEmailHtml(msg: ReturnType<typeof buildMessage>, prefix: string | null) {
  const rankSuffix = msg.editorRank != null ? ` (Rank ${msg.editorRank})` : ''
  const parts = [
    prefix ? `<p style="color:#666;margin:0 0 12px">${escapeHtml(prefix)}</p>` : '',
    `<h2 style="margin:0 0 12px">${escapeHtml(msg.title)}</h2>`,
    `<p><a href="${escapeHtml(msg.permalink)}">${escapeHtml(msg.permalink)}</a></p>`,
    msg.lockLevel != null ? `<p><strong>Lock Level:</strong> ${msg.lockLevel}</p>` : '',
    msg.submittedBy
      ? `<p><strong>Submitted by:</strong> <a href="${escapeHtml(userProfileUrl(msg.submittedBy))}">${escapeHtml(msg.submittedBy)}</a>${escapeHtml(rankSuffix)}</p>`
      : '',
    msg.notes ? `<p><strong>Notes:</strong><br>${escapeHtml(msg.notes).replaceAll('\n', '<br>')}</p>` : '',
    msg.screenshotUrl
      ? `<p><img src="${escapeHtml(msg.screenshotUrl)}" alt="Map viewport screenshot" style="max-width:100%"></p>`
      : '',
  ]
  return parts.filter(Boolean).join('\n')
}

async function sendEmail(
  msg: ReturnType<typeof buildMessage>,
  prefix: string | null,
  toEmail: string,
  emailCredentialId: number | null,
) {
  if (!emailCredentialId) throw new Error('No email credential configured for this channel')
  const credential = await resolveEmailCredential(emailCredentialId)

  const rankSuffix = msg.editorRank != null ? ` (Rank ${msg.editorRank})` : ''
  const lines = bodyLines(msg)
  if (msg.submittedBy) lines.push(`Submitted by: ${msg.submittedBy}${rankSuffix} — ${userProfileUrl(msg.submittedBy)}`)
  const subject = prefix ? `[${prefix}] ${msg.title}` : msg.title

  await dispatchEmail(credential, {
    to: toEmail,
    subject,
    textBody: lines.join('\n'),
    htmlBody: buildEmailHtml(msg, prefix),
  })
}

// Plain structured JSON for arbitrary custom integrations — no platform-specific
// formatting, unlike the Slack/Discord/Telegram senders above.
async function sendWebhook(webhookUrl: string, msg: ReturnType<typeof buildMessage>, prefix: string | null) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: msg.title,
      prefix,
      permalink: msg.permalink,
      lock_level: msg.lockLevel,
      notes: msg.notes,
      submitted_by: msg.submittedBy,
      submitted_by_url: msg.submittedBy ? userProfileUrl(msg.submittedBy) : null,
      editor_rank: msg.editorRank,
      screenshot_url: msg.screenshotUrl,
    }),
  })
}

const GOOGLE_SHEET_HEADERS = [
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

async function sendGoogleSheet(
  channel: NotificationChannel,
  msg: ReturnType<typeof buildMessage>,
  vars: PrefixVars,
) {
  if (!channel.spreadsheet_id) return
  if (!channel.google_credential_id) throw new Error('No Google service account configured for this channel')
  const credentials = await resolveGoogleCredential(channel.google_credential_id)

  await appendSheetRow(
    credentials,
    channel.spreadsheet_id,
    channel.sheet_name,
    [
      new Date().toISOString(),
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
    ],
    GOOGLE_SHEET_HEADERS,
  )
}

async function dispatchChannel(channel: NotificationChannel, msg: ReturnType<typeof buildMessage>, vars: PrefixVars) {
  try {
    const prefix = channel.custom_prefix ? applyPrefixTemplate(channel.custom_prefix, vars) : null
    if (channel.platform === 'slack' && channel.webhook_url) await sendSlack(channel.webhook_url, msg, prefix)
    if (channel.platform === 'slack_threaded') await sendSlackThreaded(channel, msg, prefix)
    if (channel.platform === 'discord' && channel.webhook_url)
      await sendDiscord(channel.webhook_url, msg, prefix, !!channel.discord_forum)
    if (channel.platform === 'discord_bot') await sendDiscordBot(channel, msg, prefix)
    if (channel.platform === 'telegram' && channel.bot_token && channel.chat_id)
      await sendTelegram(channel.bot_token, channel.chat_id, msg, prefix)
    if (channel.platform === 'email' && channel.email_to)
      await sendEmail(msg, prefix, channel.email_to, channel.email_credential_id)
    if (channel.platform === 'webhook' && channel.webhook_url) await sendWebhook(channel.webhook_url, msg, prefix)
    if (channel.platform === 'google_chat' && channel.webhook_url) await sendGoogleChat(channel.webhook_url, msg, prefix)
    if (channel.platform === 'ntfy' && channel.webhook_url)
      await sendNtfy(channel.webhook_url, channel.bot_token, msg, prefix)
    if (channel.platform === 'gotify' && channel.webhook_url && channel.bot_token)
      await sendGotify(channel.webhook_url, channel.bot_token, msg, prefix)
    if (channel.platform === 'google_sheets') await sendGoogleSheet(channel, msg, vars)
    return { id: channel.id, ok: true }
  } catch (e) {
    return { id: channel.id, ok: false, error: (e as Error).message }
  }
}

// Region-scoped channels take priority: if the request's region has any channels matching
// this event type, only those fire. Otherwise (no region, or the region has none configured)
// falls back to the country's own (region_id IS NULL) channels — see migrations/0011_regions.sql.
async function audienceChannels(countryId: number, regionId: number | null, requestType: RequestType) {
  if (regionId) {
    const regionChannels = await dbAll<NotificationChannel>(
      `SELECT * FROM notification_channels WHERE region_id = ? AND event_type IN ('global', ?)`,
      [regionId, requestType],
    )
    if (regionChannels.length) return regionChannels
  }
  return dbAll<NotificationChannel>(
    `SELECT * FROM notification_channels WHERE country_id = ? AND region_id IS NULL AND event_type IN ('global', ?)`,
    [countryId, requestType],
  )
}

// Self-service push subscriptions (src/lib/subscriptions.ts) fire independently of the
// admin-configured channels above — a matching subscription doesn't require any channel to
// exist for that country/region.
async function dispatchPush(sub: PushSubscriptionRow, msg: ReturnType<typeof buildMessage>) {
  try {
    const result = await sendPush(
      { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      { title: msg.title, body: msg.notes || `Permalink: ${msg.permalink}`, url: msg.permalink },
    )
    if (result === 'gone') await deleteSubscriptionById(sub.id)
  } catch (e) {
    console.error('Push delivery failed', e)
  }
}

export async function fireNotifications(
  request: RequestRow,
  countryName: string,
  countryCode: string,
  regionName: string | null = null,
  regionCode: string | null = null,
) {
  const channels = await audienceChannels(request.country_id, request.region_id, request.type)
  const pushSubs = await audiencePushSubscriptions(request.country_id, request.region_id, request.type)
  if (!channels.length && !pushSubs.length) return
  const msg = buildMessage(request, countryName, regionName)
  const vars: PrefixVars = {
    country_code: countryCode,
    country_name: countryName,
    region_code: regionCode || '',
    region_name: regionName || '',
    lock_level: request.lock_level != null ? String(request.lock_level) : '',
    editor_rank: request.editor_rank != null ? String(request.editor_rank) : '',
    type: request.type,
    submitted_by: request.submitted_by || '',
  }
  await Promise.allSettled([
    ...channels.map((ch) => dispatchChannel(ch, msg, vars)),
    ...pushSubs.map((sub) => dispatchPush(sub, msg)),
  ])
}

export async function sendTestMessage(
  channel: NotificationChannel,
  countryName: string,
  countryCode: string,
  regionName: string | null = null,
  regionCode: string | null = null,
) {
  const vars: PrefixVars = {
    country_code: countryCode,
    country_name: countryName,
    region_code: regionCode || '',
    region_name: regionName || '',
    lock_level: '3',
    editor_rank: '3',
    type: channel.event_type === 'global' ? 'downlock' : channel.event_type,
    submitted_by: 'TestUser',
  }
  return dispatchChannel(
    channel,
    {
      requestId: null,
      title: `Test Notification — ${channel.label}`,
      color: 0x2ecc71,
      permalink: 'https://www.waze.com/editor',
      lockLevel: null,
      notes: `This is a test message from WME Requests, confirming the "${channel.label}" channel is configured correctly.`,
      submittedBy: null,
      editorRank: null,
      screenshotUrl: null,
    },
    vars,
  )
}
