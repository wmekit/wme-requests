import { dbAll, dbFirst, dbRun } from './db'
import { json, err } from './http'
import { canAccessCountry, getUserAccess, type UserAccess } from './access'
import { getCentralSession } from './central-auth'
import {
  botInviteUrl,
  decodeInstallState,
  encodeInstallState,
  exchangeInstallCode,
  isBotConfigured,
  listGuildRoles,
  listGuildTextChannels,
} from './discord-bot'

// Discord servers a country has added this app's bot to (see src/lib/discord-bot.ts). A
// "discord_bot" channel can only post to a server linked to its own country — the bot is shared
// by every country, so a pasted-in server or channel ID could otherwise point at anyone's server.

export interface DiscordGuild {
  id: number
  country_id: number
  guild_id: string
  guild_name: string
  added_by: string | null
  created_at: string
}

export async function isGuildLinked(countryId: number, guildId: string) {
  return !!(await dbFirst('SELECT 1 FROM discord_guilds WHERE country_id = ? AND guild_id = ?', [countryId, guildId]))
}

export async function getDiscordGuilds(access: UserAccess, countryId: number) {
  if (!canAccessCountry(access, countryId)) return err('Country not found', 404)
  const rows = await dbAll<DiscordGuild>('SELECT * FROM discord_guilds WHERE country_id = ? ORDER BY guild_name', [
    countryId,
  ])
  return json(rows)
}

export async function getDiscordGuildChannels(access: UserAccess, countryId: number, guildId: string) {
  if (!canAccessCountry(access, countryId)) return err('Country not found', 404)
  if (!(await isGuildLinked(countryId, guildId))) return err('Discord server not linked to this country', 404)
  try {
    return json(await listGuildTextChannels(guildId))
  } catch (e) {
    return err((e as Error).message, 502)
  }
}

export async function getDiscordGuildRoles(access: UserAccess, countryId: number, guildId: string) {
  if (!canAccessCountry(access, countryId)) return err('Country not found', 404)
  if (!(await isGuildLinked(countryId, guildId))) return err('Discord server not linked to this country', 404)
  try {
    return json(await listGuildRoles(guildId))
  } catch (e) {
    return err((e as Error).message, 502)
  }
}

export async function unlinkDiscordGuild(access: UserAccess, countryId: number, guildId: string) {
  if (!canAccessCountry(access, countryId)) return err('Country not found', 404)
  const inUse = await dbFirst<{ n: number }>(
    `SELECT count(*) AS n FROM notification_channels WHERE country_id = ? AND platform = 'discord_bot' AND discord_guild_id = ?`,
    [countryId, guildId],
  )
  if (inUse?.n) return err(`${inUse.n} channel(s) still post to this server — delete or change them first`, 409)
  const result = await dbRun('DELETE FROM discord_guilds WHERE country_id = ? AND guild_id = ?', [countryId, guildId])
  if (!result.meta.changes) return err('Discord server not linked to this country', 404)
  return new Response(null, { status: 204 })
}

/** Starts the install flow: off to Discord's "Add to server" page, coming back to handleInstallCallback. */
export async function startInstall(access: UserAccess, countryId: number) {
  if (!isBotConfigured()) return err('The Discord bot is not configured on this deployment', 503)
  const country = await dbFirst('SELECT id FROM countries WHERE id = ?', [countryId])
  if (!country || !canAccessCountry(access, countryId)) return err('Country not found', 404)
  const state = await encodeInstallState(countryId, access.userId)
  return new Response(null, { status: 302, headers: { Location: botInviteUrl(state) } })
}

function escapeHtml(text: string) {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(text).replace(/[&<>"']/g, (c) => entities[c])
}

// The callback opens in its own tab (the form's "Add bot" button), so it answers with a small
// page rather than JSON; the form picks the new server up when the user switches back.
function callbackPage(ok: boolean, messageHtml: string, setCookies: string[] = []) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WME Requests — Discord</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f6f8;color:#1a1b1e}
main{background:#fff;border-radius:8px;padding:24px 32px;box-shadow:0 1px 3px rgba(0,0,0,.1);max-width:420px;text-align:center}
h1{font-size:18px;margin:0 0 8px;color:${ok ? '#2b8a3e' : '#c92a2a'}}p{margin:0;line-height:1.5}</style></head>
<body><main><h1>${ok ? 'Bot added' : 'Could not add the bot'}</h1><p>${messageHtml}</p></main></body></html>`
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  for (const c of setCookies) headers.append('Set-Cookie', c)
  return new Response(html, { status: ok ? 200 : 400, headers })
}

/**
 * Discord redirects here after "Add to server". Checks the state (untampered, unexpired, started
 * by this same signed-in user who can still manage the country), then links the server Discord
 * reports in the token exchange — never one named in the query string.
 */
export async function handleInstallCallback(request: Request) {
  const url = new URL(request.url)
  const { user, setCookies } = await getCentralSession(request.headers)
  const fail = (message: string) => callbackPage(false, escapeHtml(message), setCookies)

  const error = url.searchParams.get('error')
  if (error) {
    return fail(error === 'access_denied' ? 'Adding the bot was cancelled.' : url.searchParams.get('error_description') || error)
  }
  if (!user) return fail('You are signed out — sign in to WME Requests and try again.')

  const state = await decodeInstallState(url.searchParams.get('state') ?? '')
  if (!state || state.userId !== user.id) return fail('This link has expired or is invalid. Start again from Admin.')
  const access = await getUserAccess(user.id)
  if (!access || !canAccessCountry(access, state.countryId)) return fail('You no longer have access to this country.')

  const code = url.searchParams.get('code')
  if (!code) return fail('Discord did not return an authorization code.')

  let guild: { id: string; name: string }
  try {
    guild = await exchangeInstallCode(code)
  } catch (e) {
    return fail((e as Error).message)
  }

  await dbRun(
    `INSERT INTO discord_guilds (country_id, guild_id, guild_name, added_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(country_id, guild_id) DO UPDATE SET guild_name = excluded.guild_name`,
    [state.countryId, guild.id, guild.name, user.id],
  )
  return callbackPage(
    true,
    `Bot added to <strong>${escapeHtml(guild.name)}</strong> — you can close this tab.`,
    setCookies,
  )
}
