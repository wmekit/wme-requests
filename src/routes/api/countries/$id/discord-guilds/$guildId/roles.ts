import { createFileRoute } from '@tanstack/react-router'
import { apiRoute } from '@/lib/http'
import { getDiscordGuildRoles } from '@/lib/discord-guilds'

export const Route = createFileRoute('/api/countries/$id/discord-guilds/$guildId/roles')({
  server: {
    handlers: apiRoute({
      GET: ({ params, access }) => getDiscordGuildRoles(access!, parseInt(params.id), params.guildId),
    }),
  },
})
