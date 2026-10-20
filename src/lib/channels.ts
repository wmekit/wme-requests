import { dbAll, dbFirst, dbRun, isURL, isEmail, PLATFORMS, EVENT_TYPES, type Platform, type EventType } from './db'
import { json, err } from './http'
import { sendTestMessage, type NotificationChannel } from './notifications'
import { canAccessCountry, type UserAccess } from './access'
import { credentialExists } from './credentials'
import { isGuildLinked } from './discord-guilds'
import { getChannel, listGuildRoles, FORUM_CHANNEL_TYPE, POSTABLE_CHANNEL_TYPES } from './discord-bot'

export async function getChannels(access: UserAccess, countryId: number) {
  const country = await dbFirst('SELECT id FROM countries WHERE id = ?', [countryId])
  if (!country) return err('Country not found', 404)
  if (!canAccessCountry(access, countryId)) return err('Country not found', 404)
  const rows = await dbAll<NotificationChannel & { region_name: string | null; region_code: string | null }>(
    `SELECT ch.*, g.name AS region_name, g.code AS region_code
     FROM notification_channels ch LEFT JOIN regions g ON g.id = ch.region_id
     WHERE ch.country_id = ? ORDER BY ch.event_type, ch.platform`,
    [countryId],
  )
  return json(rows)
}

interface ChannelBody {
  label?: string
  platform?: Platform
  event_type?: EventType
  // Optional — scopes the channel to one region within the country instead of the whole
  // country. null/omitted means country-wide, the pre-existing behaviour.
  region_id?: number | string | null
  webhook_url?: string | null
  bot_token?: string | null
  chat_id?: string | null
  custom_prefix?: string | null
  email_to?: string | null
  discord_forum?: boolean
  spreadsheet_id?: string | null
  sheet_name?: string | null
  // References a row in `credentials` (see src/lib/credentials.ts) — reusable across
  // channels, rather than a secret pasted directly into this channel.
  google_credential_id?: number | string | null
  email_credential_id?: number | string | null
  // discord_bot only — see resolveDiscordBotChannel.
  discord_guild_id?: string | null
  discord_channel_id?: string | null
  // discord_bot only — thread same-submitter requests, see sendDiscordBot.
  discord_threaded?: boolean
  // discord_bot only — roles in the channel's server to ping in every notification.
  discord_role_ids?: string[] | null
}

// Resolves+validates an optional region_id against the channel's country. Returns the
// normalized region id (or null), or an error message.
async function resolveRegionId(countryId: number, regionId: ChannelBody['region_id']): Promise<{ id: number | null } | { error: string }> {
  if (regionId == null || regionId === '') return { id: null }
  if (!Number.isInteger(Number(regionId))) return { error: 'region_id must be an integer' }
  const region = await dbFirst('SELECT id FROM regions WHERE id = ? AND country_id = ?', [Number(regionId), countryId])
  if (!region) return { error: 'Region not found for this country' }
  return { id: Number(regionId) }
}

// Resolves+validates an optional credential reference. Returns the normalized id (or null),
// or an error message — doesn't decrypt anything, just confirms the row exists and is the
// right kind of credential.
async function resolveCredentialId(
  value: number | string | null | undefined,
  kind: 'google' | 'email',
): Promise<{ id: number | null } | { error: string }> {
  if (value == null || value === '') return { id: null }
  if (!Number.isInteger(Number(value))) return { error: `${kind}_credential_id must be an integer` }
  if (!(await credentialExists(Number(value), kind))) {
    return { error: `${kind === 'google' ? 'Google' : 'Email'} credential not found` }
  }
  return { id: Number(value) }
}

// For discord_bot: the server must be linked to this country (it came from Discord's own
// install flow, see src/lib/discord-guilds.ts) and the channel must be one the bot can see in
// that server — otherwise anyone could aim the shared bot at a channel in someone else's server.
// Forum-ness comes from the channel itself rather than a checkbox.
async function resolveDiscordBotChannel(
  countryId: number,
  guildId: string | null | undefined,
  channelId: string | null | undefined,
): Promise<{ guildId: string; channelId: string; forum: boolean } | { error: string }> {
  if (!guildId || !channelId) return { error: 'A Discord server and channel are required for discord_bot' }
  if (!(await isGuildLinked(countryId, guildId))) return { error: 'That Discord server is not linked to this country' }
  let channel
  try {
    channel = await getChannel(channelId)
  } catch (e) {
    return { error: `Can't access that Discord channel — ${(e as Error).message}` }
  }
  if (channel.guild_id !== guildId) return { error: 'That Discord channel is not in the selected server' }
  if (!POSTABLE_CHANNEL_TYPES.includes(channel.type)) {
    return { error: 'Pick a text, announcement or forum channel' }
  }
  return { guildId, channelId, forum: channel.type === FORUM_CHANNEL_TYPE }
}

// For discord_bot: every role must exist in the channel's server (and not be @everyone or an
// integration's role — see listGuildRoles). Stored comma-separated, or null for none.
async function resolveDiscordRoles(
  guildId: string,
  roleIds: string[] | null | undefined,
): Promise<{ value: string | null } | { error: string }> {
  if (!roleIds?.length) return { value: null }
  if (!Array.isArray(roleIds) || !roleIds.every((id) => typeof id === 'string' && /^\d+$/.test(id))) {
    return { error: 'discord_role_ids must be a list of role IDs' }
  }
  let roles
  try {
    roles = await listGuildRoles(guildId)
  } catch (e) {
    return { error: `Can't load that Discord server's roles — ${(e as Error).message}` }
  }
  const valid = new Set(roles.map((r) => r.id))
  if (roleIds.some((id) => !valid.has(id))) return { error: 'One of those roles is not in the selected Discord server' }
  return { value: [...new Set(roleIds)].join(',') }
}

// Returns an error message if the platform-specific required fields are missing/invalid, else null.
function validatePlatformFields(
  platform: Platform,
  fields: Pick<ChannelBody, 'webhook_url' | 'bot_token' | 'chat_id' | 'email_to' | 'spreadsheet_id'>,
) {
  const { webhook_url, bot_token, chat_id, email_to, spreadsheet_id } = fields
  if (
    platform === 'slack' ||
    platform === 'discord' ||
    platform === 'webhook' ||
    platform === 'google_chat' ||
    platform === 'ntfy' ||
    platform === 'gotify'
  ) {
    if (!webhook_url) return `webhook_url is required for ${platform}`
    if (!isURL(webhook_url)) return 'webhook_url must be a valid URL'
  }
  if (platform === 'telegram' && (!bot_token || !chat_id)) return 'bot_token and chat_id are required for telegram'
  if (platform === 'slack_threaded' && (!bot_token || !chat_id))
    return 'bot_token and chat_id are required for slack_threaded'
  // Gotify's application token is required (there's no anonymous publish); ntfy's is optional —
  // only protected topics need one, public topics work without any auth.
  if (platform === 'gotify' && !bot_token) return 'An application token is required for gotify'
  if (platform === 'email') {
    if (!email_to) return 'email_to is required for email'
    if (!isEmail(email_to)) return 'email_to must be a valid email address'
  }
  if (platform === 'google_sheets' && !spreadsheet_id?.trim()) return 'spreadsheet_id is required for google_sheets'
  return null
}

export async function createChannel(access: UserAccess, countryId: number, body: ChannelBody) {
  const country = await dbFirst('SELECT id FROM countries WHERE id = ?', [countryId])
  if (!country) return err('Country not found', 404)
  if (!canAccessCountry(access, countryId)) return err('Country not found', 404)

  const {
    label,
    platform,
    event_type,
    region_id,
    webhook_url,
    bot_token,
    chat_id,
    custom_prefix,
    email_to,
    discord_forum,
    spreadsheet_id,
    sheet_name,
  } = body
  if (!label?.trim()) return err('label is required')
  if (!platform || !PLATFORMS.includes(platform)) return err(`platform must be one of: ${PLATFORMS.join(', ')}`)
  if (!event_type || !EVENT_TYPES.includes(event_type))
    return err(`event_type must be one of: ${EVENT_TYPES.join(', ')}`)

  const resolvedRegion = await resolveRegionId(countryId, region_id)
  if ('error' in resolvedRegion) return err(resolvedRegion.error)

  const platformError = validatePlatformFields(platform, { webhook_url, bot_token, chat_id, email_to, spreadsheet_id })
  if (platformError) return err(platformError)

  const resolvedGoogleCred = await resolveCredentialId(body.google_credential_id, 'google')
  if ('error' in resolvedGoogleCred) return err(resolvedGoogleCred.error)
  if (platform === 'google_sheets' && !resolvedGoogleCred.id) return err('A Google credential is required for google_sheets')

  const resolvedEmailCred = await resolveCredentialId(body.email_credential_id, 'email')
  if ('error' in resolvedEmailCred) return err(resolvedEmailCred.error)
  if (platform === 'email' && !resolvedEmailCred.id) return err('An email credential is required for email')

  let discordBot: { guildId: string; channelId: string; forum: boolean } | null = null
  let discordRoles: string | null = null
  if (platform === 'discord_bot') {
    const resolved = await resolveDiscordBotChannel(countryId, body.discord_guild_id, body.discord_channel_id)
    if ('error' in resolved) return err(resolved.error)
    discordBot = resolved
    const roles = await resolveDiscordRoles(resolved.guildId, body.discord_role_ids)
    if ('error' in roles) return err(roles.error)
    discordRoles = roles.value
  }

  const result = await dbRun(
    `INSERT INTO notification_channels
       (country_id, region_id, label, platform, event_type, webhook_url, bot_token, chat_id, custom_prefix, email_to, discord_forum, spreadsheet_id, sheet_name, google_credential_id, email_credential_id, discord_guild_id, discord_channel_id, discord_threaded, discord_role_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      countryId,
      resolvedRegion.id,
      label.trim(),
      platform,
      event_type,
      webhook_url || null,
      bot_token || null,
      chat_id || null,
      custom_prefix?.trim() || null,
      email_to?.trim() || null,
      (discordBot ? discordBot.forum : discord_forum) ? 1 : 0,
      spreadsheet_id?.trim() || null,
      sheet_name?.trim() || null,
      resolvedGoogleCred.id,
      resolvedEmailCred.id,
      discordBot?.guildId ?? null,
      discordBot?.channelId ?? null,
      discordBot && body.discord_threaded ? 1 : 0,
      discordRoles,
    ],
  )
  const row = await dbFirst<NotificationChannel>('SELECT * FROM notification_channels WHERE id = ?', [
    result.meta.last_row_id,
  ])
  return json(row!, 201)
}

export async function updateChannel(access: UserAccess, id: number, body: ChannelBody) {
  const existing = await dbFirst<NotificationChannel>('SELECT * FROM notification_channels WHERE id = ?', [id])
  if (!existing) return err('Channel not found', 404)
  if (!canAccessCountry(access, existing.country_id)) return err('Channel not found', 404)

  const label = body.label?.trim() || existing.label
  const platform = body.platform && PLATFORMS.includes(body.platform) ? body.platform : existing.platform
  const event_type = body.event_type && EVENT_TYPES.includes(body.event_type) ? body.event_type : existing.event_type

  let region_id = existing.region_id
  if (body.region_id !== undefined) {
    const resolvedRegion = await resolveRegionId(existing.country_id, body.region_id)
    if ('error' in resolvedRegion) return err(resolvedRegion.error)
    region_id = resolvedRegion.id
  }

  const webhook_url = body.webhook_url !== undefined ? body.webhook_url : existing.webhook_url
  const bot_token = body.bot_token !== undefined ? body.bot_token : existing.bot_token
  const chat_id = body.chat_id !== undefined ? body.chat_id : existing.chat_id
  const custom_prefix =
    body.custom_prefix !== undefined ? body.custom_prefix?.trim() || null : existing.custom_prefix
  const email_to = body.email_to !== undefined ? body.email_to?.trim() || null : existing.email_to
  let discord_forum = body.discord_forum !== undefined ? (body.discord_forum ? 1 : 0) : existing.discord_forum
  const spreadsheet_id =
    body.spreadsheet_id !== undefined ? body.spreadsheet_id?.trim() || null : existing.spreadsheet_id
  const sheet_name = body.sheet_name !== undefined ? body.sheet_name?.trim() || null : existing.sheet_name

  let google_credential_id = existing.google_credential_id
  if (body.google_credential_id !== undefined) {
    const resolved = await resolveCredentialId(body.google_credential_id, 'google')
    if ('error' in resolved) return err(resolved.error)
    google_credential_id = resolved.id
  }
  if (platform === 'google_sheets' && !google_credential_id) {
    return err('A Google credential is required for google_sheets')
  }

  let email_credential_id = existing.email_credential_id
  if (body.email_credential_id !== undefined) {
    const resolved = await resolveCredentialId(body.email_credential_id, 'email')
    if ('error' in resolved) return err(resolved.error)
    email_credential_id = resolved.id
  }
  if (platform === 'email' && !email_credential_id) {
    return err('An email credential is required for email')
  }

  let discord_guild_id: string | null = null
  let discord_channel_id: string | null = null
  let discord_threaded = 0
  let discord_role_ids: string | null = null
  if (platform === 'discord_bot') {
    discord_threaded =
      body.discord_threaded !== undefined ? (body.discord_threaded ? 1 : 0) : existing.discord_threaded
    discord_guild_id = body.discord_guild_id !== undefined ? body.discord_guild_id : existing.discord_guild_id
    discord_channel_id = body.discord_channel_id !== undefined ? body.discord_channel_id : existing.discord_channel_id
    // Re-checked only when the target changes, so editing e.g. the label doesn't fail just
    // because Discord is unreachable or the bot has since lost access.
    const targetChanged =
      existing.platform !== 'discord_bot' ||
      discord_guild_id !== existing.discord_guild_id ||
      discord_channel_id !== existing.discord_channel_id
    if (targetChanged) {
      const resolved = await resolveDiscordBotChannel(existing.country_id, discord_guild_id, discord_channel_id)
      if ('error' in resolved) return err(resolved.error)
      discord_forum = resolved.forum ? 1 : 0
    } else {
      discord_forum = existing.discord_forum
    }
    // Same as the target: only re-checked against Discord when the roles or the server change.
    const previousRoles = existing.platform === 'discord_bot' ? existing.discord_role_ids : null
    const roleIds = body.discord_role_ids !== undefined ? body.discord_role_ids : previousRoles?.split(',')
    discord_role_ids = previousRoles
    if (targetChanged || (roleIds ?? []).join(',') !== (previousRoles ?? '')) {
      const roles = await resolveDiscordRoles(discord_guild_id!, roleIds)
      if ('error' in roles) return err(roles.error)
      discord_role_ids = roles.value
    }
  }

  await dbRun(
    `UPDATE notification_channels
     SET label=?, platform=?, event_type=?, region_id=?, webhook_url=?, bot_token=?, chat_id=?, custom_prefix=?, email_to=?,
         discord_forum=?, spreadsheet_id=?, sheet_name=?, google_credential_id=?, email_credential_id=?,
         discord_guild_id=?, discord_channel_id=?, discord_threaded=?, discord_role_ids=?
     WHERE id=?`,
    [
      label,
      platform,
      event_type,
      region_id,
      webhook_url,
      bot_token,
      chat_id,
      custom_prefix,
      email_to,
      discord_forum,
      spreadsheet_id,
      sheet_name,
      google_credential_id,
      email_credential_id,
      discord_guild_id,
      discord_channel_id,
      discord_threaded,
      discord_role_ids,
      id,
    ],
  )
  const row = await dbFirst<NotificationChannel>('SELECT * FROM notification_channels WHERE id = ?', [id])
  return json(row!)
}

export async function deleteChannel(access: UserAccess, id: number) {
  const existing = await dbFirst<NotificationChannel>('SELECT * FROM notification_channels WHERE id = ?', [id])
  if (!existing) return err('Channel not found', 404)
  if (!canAccessCountry(access, existing.country_id)) return err('Channel not found', 404)
  const result = await dbRun('DELETE FROM notification_channels WHERE id = ?', [id])
  if (!result.meta.changes) return err('Channel not found', 404)
  return new Response(null, { status: 204 })
}

export async function testChannel(access: UserAccess, id: number) {
  const channel = await dbFirst<NotificationChannel>('SELECT * FROM notification_channels WHERE id = ?', [id])
  if (!channel) return err('Channel not found', 404)
  if (!canAccessCountry(access, channel.country_id)) return err('Channel not found', 404)
  const country = await dbFirst<{ name: string; code: string }>('SELECT name, code FROM countries WHERE id = ?', [
    channel.country_id,
  ])
  if (!country) return err('Country not found', 404)

  let region: { name: string; code: string } | null = null
  if (channel.region_id != null) {
    region = await dbFirst('SELECT name, code FROM regions WHERE id = ?', [channel.region_id])
  }

  const result = await sendTestMessage(channel, country.name, country.code, region?.name ?? null, region?.code ?? null)
  if (!result.ok) return err(result.error || 'Failed to send test notification', 502)
  return json({ ok: true })
}
