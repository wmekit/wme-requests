import { env } from 'cloudflare:workers'
import { encryptSecret, decryptSecret } from './crypto'

// This app's own Discord bot, used by the "discord_bot" notification platform. Everything is
// plain REST with the bot token — no gateway connection, so nothing to keep running beyond the
// Worker. Server admins add the bot through the OAuth2 install flow (botInviteUrl →
// /api/discord/callback), which links the server to a country in `discord_guilds`.

const API = 'https://discord.com/api/v10'

// View Channel, Send Messages, Embed Links, Send Messages in Threads (also needed to create
// forum posts), Create Public Threads (for threaded channels), and Mention Everyone (so
// @here/@everyone/role mentions in a channel's custom prefix actually ping — the inviting admin
// can untick it).
const BOT_PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 38n) | (1n << 35n) | (1n << 17n)

// Text, announcement and forum channels — the ones the bot can post a notification into.
export const POSTABLE_CHANNEL_TYPES = [0, 5, 15]
export const FORUM_CHANNEL_TYPE = 15
const CATEGORY_CHANNEL_TYPE = 4

const STATE_TTL_MS = 10 * 60 * 1000

export function isBotConfigured() {
  return !!(env.DISCORD_APPLICATION_ID && env.DISCORD_BOT_TOKEN && env.DISCORD_CLIENT_SECRET)
}

function redirectUri() {
  return new URL('/api/discord/callback', env.APP_URL).href
}

// Discord's JSON error code (e.g. 10003 Unknown Channel), when it sent one.
export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
  }
}

export const UNKNOWN_CHANNEL = 10003

/**
 * Calls Discord's REST API as the bot. Retries once on a 429 after Discord's `retry_after`;
 * any other failure throws with Discord's own message (e.g. "Missing Access", "Unknown
 * Channel"), which is what the Test button shows.
 */
export async function discordApi<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (res.status === 429 && !retried) {
    const body = await res.json<{ retry_after?: number }>().catch(() => ({ retry_after: undefined }))
    await new Promise((r) => setTimeout(r, Math.min(body.retry_after ?? 1, 10) * 1000))
    return discordApi<T>(path, init, true)
  }
  if (!res.ok) {
    const body = await res.json<{ message?: string; code?: number }>().catch(() => ({ message: undefined, code: undefined }))
    throw new DiscordApiError(`Discord: ${body.message || `${res.status} ${res.statusText}`}`, body.code)
  }
  if (res.status === 204) return null as T
  return res.json<T>()
}

export function botInviteUrl(state: string) {
  const url = new URL('https://discord.com/oauth2/authorize')
  url.searchParams.set('client_id', env.DISCORD_APPLICATION_ID)
  url.searchParams.set('scope', 'bot')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('state', state)
  url.searchParams.set('permissions', BOT_PERMISSIONS.toString())
  return url.href
}

/**
 * Exchanges the install flow's code for the server the bot was added to. The guild comes from
 * Discord's token response, so (unlike anything in the callback's query string) it can be trusted.
 */
export async function exchangeInstallCode(code: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${env.DISCORD_APPLICATION_ID}:${env.DISCORD_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() }),
  })
  const data = await res.json<{ guild?: { id: string; name: string }; error_description?: string; error?: string }>()
  if (!res.ok) throw new Error(data.error_description || data.error || `Token exchange failed (${res.status})`)
  if (!data.guild) throw new Error('Discord did not say which server the bot was added to')
  return { id: data.guild.id, name: data.guild.name }
}

interface DiscordChannel {
  id: string
  type: number
  name: string
  position: number
  parent_id?: string | null
  guild_id?: string
}

export interface GuildTextChannel {
  id: string
  name: string
  type: number
  parentName: string | null
}

/** The server's postable channels, in the order Discord shows them: by category, then position. */
export async function listGuildTextChannels(guildId: string): Promise<GuildTextChannel[]> {
  const all = await discordApi<DiscordChannel[]>(`/guilds/${encodeURIComponent(guildId)}/channels`)
  const categories = new Map(all.filter((c) => c.type === CATEGORY_CHANNEL_TYPE).map((c) => [c.id, c]))
  // Uncategorised channels sit above every category.
  const categoryPosition = (c: DiscordChannel) => (c.parent_id ? (categories.get(c.parent_id)?.position ?? 0) + 1 : 0)
  return all
    .filter((c) => POSTABLE_CHANNEL_TYPES.includes(c.type))
    .sort((a, b) => categoryPosition(a) - categoryPosition(b) || a.position - b.position)
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      parentName: c.parent_id ? (categories.get(c.parent_id)?.name ?? null) : null,
    }))
}

// Buttons on each request message in a threaded channel (see sendDiscordBot), handled by
// src/lib/discord-interactions.ts. Only added once DISCORD_PUBLIC_KEY is set, since without it
// clicks can't be verified and would just fail.
export const REQUEST_STATUS_BUTTON = 'request-status'
export const CLOSE_THREAD_BUTTON = 'close-thread'

export function interactionsConfigured() {
  return !!env.DISCORD_PUBLIC_KEY
}

export function closeThreadButton() {
  return { type: 2, style: 2, label: 'Close thread', emoji: { name: '🔒' }, custom_id: CLOSE_THREAD_BUTTON }
}

export function requestButtons(requestId: number) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Complete', custom_id: `${REQUEST_STATUS_BUTTON}:completed:${requestId}` },
        { type: 2, style: 4, label: 'Reject', custom_id: `${REQUEST_STATUS_BUTTON}:rejected:${requestId}` },
        closeThreadButton(),
      ],
    },
  ]
}

function hexToBytes(hex: string) {
  return new Uint8Array((hex.match(/../g) ?? []).map((b) => parseInt(b, 16)))
}

/** Checks Discord's Ed25519 signature on an interaction (timestamp + raw body). */
export async function verifyInteraction(request: Request, body: string) {
  const signature = request.headers.get('X-Signature-Ed25519')
  const timestamp = request.headers.get('X-Signature-Timestamp')
  if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) return false
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(env.DISCORD_PUBLIC_KEY), { name: 'Ed25519' }, false, [
      'verify',
    ])
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(signature), new TextEncoder().encode(timestamp + body))
  } catch {
    return false
  }
}

/** Throws (e.g. "Missing Access", "Unknown Channel") if the bot can't see the channel. */
export function getChannel(channelId: string) {
  return discordApi<DiscordChannel>(`/channels/${encodeURIComponent(channelId)}`)
}

// OAuth `state` for the install flow: which country to link the server to and who started it,
// encrypted (AES-GCM, so it's also tamper-proof) with the same key as stored credentials.
interface InstallState {
  countryId: number
  userId: string
  exp: number
}

function toBase64Url(s: string) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string) {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'))
}

export async function encodeInstallState(countryId: number, userId: string) {
  const state: InstallState = { countryId, userId, exp: Date.now() + STATE_TTL_MS }
  return toBase64Url(await encryptSecret(JSON.stringify(state)))
}

/** The decoded state, or null if it was tampered with or has expired. */
export async function decodeInstallState(raw: string): Promise<InstallState | null> {
  try {
    const state = JSON.parse(await decryptSecret(fromBase64Url(raw))) as InstallState
    if (typeof state.exp !== 'number' || state.exp < Date.now()) return null
    return state
  } catch {
    return null
  }
}
