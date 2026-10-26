import { createFileRoute } from '@tanstack/react-router'
import { apiRoute } from '@/lib/http'
import { getDiscordGuildEmojis } from '@/lib/discord-guilds'

export const Route = createFileRoute('/api/countries/$id/discord-guilds/$guildId/emojis')({
  server: {
    handlers: apiRoute({
      GET: ({ params, access }) => getDiscordGuildEmojis(access!, parseInt(params.id), params.guildId),
    }),
  },
})
