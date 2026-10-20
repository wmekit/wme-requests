import { waitUntil } from 'cloudflare:workers'
import { dbFirst, dbRun } from './db'
import { json } from './http'
import { isGuildLinked } from './discord-guilds'
import {
  closeThreadButton,
  discordApi,
  verifyInteraction,
  DiscordApiError,
  CLOSE_THREAD_BUTTON,
  REQUEST_STATUS_BUTTON,
} from './discord-bot'

// Discord's Interactions Endpoint URL (/api/discord/interactions): handles clicks on the buttons
// sendDiscordBot puts on threaded channels' request messages. Discord signs every call, so this
// is public; the clicker must hold Manage Threads (or Administrator) in that channel — Discord
// accounts aren't tied to this app's users, so that's the only gate there is.

const PING = 1
const MESSAGE_COMPONENT = 3
const THREAD_CHANNEL_TYPES = [10, 11, 12]
const MANAGE_THREADS = 1n << 34n
const ADMINISTRATOR = 1n << 3n
const EPHEMERAL = 64
const MISSING_PERMISSIONS = 50013

const STATUS_LABELS: Record<string, string> = { completed: 'Completed', rejected: 'Rejected' }

interface Embed {
  title?: string
  description?: string
  color?: number
  timestamp?: string
  image?: { url: string }
}

interface Interaction {
  type: number
  application_id: string
  token: string
  guild_id?: string
  channel_id?: string
  channel?: { id: string; type: number }
  member?: { user: { id: string }; permissions: string }
  data?: { custom_id?: string }
  message?: { id: string; embeds?: Embed[]; thread?: { id: string } }
}

function ephemeral(content: string) {
  return json({ type: 4, data: { content, flags: EPHEMERAL } })
}

export async function handleInteraction(request: Request) {
  const body = await request.text()
  if (!(await verifyInteraction(request, body))) return new Response('Invalid request signature', { status: 401 })
  const interaction = JSON.parse(body) as Interaction

  if (interaction.type === PING) return json({ type: PING })
  const customId = interaction.data?.custom_id
  if (interaction.type !== MESSAGE_COMPONENT || !customId || !interaction.message) {
    return ephemeral('This interaction isn’t supported.')
  }
  if (!interaction.guild_id || !interaction.member) return ephemeral('These buttons only work in a server.')
  if (!(BigInt(interaction.member.permissions) & (MANAGE_THREADS | ADMINISTRATOR))) {
    return ephemeral('You need the **Manage Threads** permission in this channel to use these buttons.')
  }

  if (customId === CLOSE_THREAD_BUTTON) return closeThread(interaction)
  const [kind, status, requestId] = customId.split(':')
  if (kind === REQUEST_STATUS_BUTTON) return setRequestStatus(interaction, status, Number(requestId))
  return ephemeral('Unknown button.')
}

// Updates the request, then edits the message in place: a status line on the embed, and only
// the Close thread button left.
async function setRequestStatus(interaction: Interaction, status: string, requestId: number) {
  if (!STATUS_LABELS[status] || !Number.isInteger(requestId)) return ephemeral('Unknown button.')
  const req = await dbFirst<{ country_id: number }>('SELECT country_id FROM requests WHERE id = ?', [requestId])
  if (!req) return ephemeral('This request no longer exists.')
  if (!(await isGuildLinked(req.country_id, interaction.guild_id!))) {
    return ephemeral('This server isn’t linked to the request’s country.')
  }

  await dbRun(`UPDATE requests SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [
    status,
    requestId,
  ])

  const statusLine = `**Status:** ${STATUS_LABELS[status]} by <@${interaction.member!.user.id}>`
  const embeds = (interaction.message!.embeds ?? []).map((e, i) => ({
    title: e.title,
    description: i === 0 ? [e.description, statusLine].filter(Boolean).join('\n') : e.description,
    color: e.color,
    timestamp: e.timestamp,
    ...(e.image?.url ? { image: { url: e.image.url } } : {}),
  }))
  return json({
    type: 7,
    data: { embeds, components: [{ type: 1, components: [closeThreadButton()] }], allowed_mentions: { parse: [] } },
  })
}

// Archives and locks the thread the button belongs to — the one the message is in (a forum post, or a
// reply in a text-channel thread), or the one started from it — and ends the submitter's thread
// chain so their next request starts a new one. Deferred, since it's a few Discord calls.
// Archiving comes last: anything posted in the thread afterwards (even the reply to this click)
// would unarchive it again. Locking stops other members' replies reopening it.
async function closeThread(interaction: Interaction) {
  const message = interaction.message!
  const inThread = !!interaction.channel && THREAD_CHANNEL_TYPES.includes(interaction.channel.type)
  const threadId = inThread ? interaction.channel_id! : (message.thread?.id ?? null)
  const userId = interaction.member!.user.id

  if (!(await dbFirst('SELECT 1 FROM discord_guilds WHERE guild_id = ?', [interaction.guild_id!]))) {
    return ephemeral('This server isn’t linked to WME Requests.')
  }

  const followUp = (content: string) =>
    discordApi(`/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    })

  waitUntil(
    (async () => {
      try {
        // A thread's id is its starter message's, which is what last_thread_ts holds.
        await dbRun(
          `UPDATE notification_channels SET last_thread_submitted_by = NULL, last_thread_ts = NULL, last_thread_day = NULL
           WHERE platform = 'discord_bot' AND last_thread_ts = ?`,
          [threadId ?? message.id],
        )
        if (!threadId) {
          await followUp('No thread yet — the next request from this submitter will start a new message.')
          return
        }
        const thread = encodeURIComponent(threadId)
        await discordApi(`/channels/${thread}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: `🔒 Thread closed by <@${userId}>.`, allowed_mentions: { parse: [] } }),
        })
        await followUp('Thread closed.')
        await discordApi(`/channels/${thread}`, {
          method: 'PATCH',
          body: JSON.stringify({ archived: true, locked: true }),
        })
      } catch (e) {
        const reason =
          e instanceof DiscordApiError && e.code === MISSING_PERMISSIONS
            ? 'the bot needs the **Manage Threads** permission in this channel.'
            : (e as Error).message
        await followUp(`Couldn’t close the thread — ${reason}`).catch(() => {})
      }
    })(),
  )
  return json({ type: 5, data: { flags: EPHEMERAL } })
}
