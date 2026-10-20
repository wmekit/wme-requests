import { createFileRoute } from '@tanstack/react-router'
import { apiRoute } from '@/lib/http'
import { handleInteraction } from '@/lib/discord-interactions'

export const Route = createFileRoute('/api/discord/interactions')({
  server: {
    handlers: apiRoute({
      // Discord's Interactions Endpoint URL — public, since Discord calls it; every request's
      // Ed25519 signature is checked by handleInteraction.
      POST: { public: true, handler: ({ request }) => handleInteraction(request) },
    }),
  },
})
