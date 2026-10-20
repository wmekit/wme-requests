import { createFileRoute } from '@tanstack/react-router'
import { Anchor, Card, Code, Container, Group, List, Stack, Text, Title } from '@mantine/core'
import { Bell, Rss, ShieldCheck } from 'lucide-react'
import { PlatformBadge } from '@/lib/labels'
import type { Platform } from '@/lib/types'

export const Route = createFileRoute('/help')({ component: Help })

interface HelpSection {
  platform: Platform
  summary: string
  steps: React.ReactNode[]
}

const SECTIONS: HelpSection[] = [
  {
    platform: 'slack',
    summary: 'Posts a formatted card to a Slack channel via an Incoming Webhook.',
    steps: [
      <>
        Go to{' '}
        <Anchor href="https://api.slack.com/apps" target="_blank" rel="noopener">
          api.slack.com/apps
        </Anchor>{' '}
        and click <strong>Create New App</strong> → <strong>From scratch</strong>.
      </>,
      <>
        Under <strong>Incoming Webhooks</strong>, toggle it on, then click{' '}
        <strong>Add New Webhook to Workspace</strong> and choose the target channel.
      </>,
      <>
        Copy the generated Webhook URL and paste it into <Code>Webhook URL</Code> when adding a Slack channel here.
      </>,
    ],
  },
  {
    platform: 'discord',
    summary: 'Posts an embed to a Discord channel (or a new forum post, for Forum channels) via a webhook.',
    steps: [
      <>
        In Discord, open the target channel's <strong>Settings → Integrations → Webhooks</strong>.
      </>,
      <>
        Click <strong>New Webhook</strong>, optionally rename it, then <strong>Copy Webhook URL</strong>.
      </>,
      <>
        Paste it into <Code>Webhook URL</Code>. If the target is a <strong>Forum</strong> channel, also enable
        "Post as a new thread" — each notification creates a new forum post rather than a reply.
      </>,
    ],
  },
  {
    platform: 'discord_bot',
    summary:
      'Posts the same embed as the WME Requests bot, to a channel picked from a list — no webhook to create or paste.',
    steps: [
      <>
        Add a channel, choose <strong>Discord (Bot)</strong>, and click <strong>Add bot</strong>.
        You need the <strong>Manage Server</strong> permission in that server.
      </>,
      <>
        In the tab that opens, pick the server and authorize the bot, then switch back. The server is now linked to
        this country.
      </>,
      <>
        Pick the server and channel. The bot needs to be able to see the channel — check its permissions if the channel
        is private. Forum channels get a new post per notification.
      </>,
      <>
        Optionally tick <strong>Thread requests from the same submitter</strong> — consecutive requests from one
        submitter on the same day then go into a single thread (or forum post) instead of separate messages. Each
        request gets <strong>Complete</strong>, <strong>Reject</strong> and <strong>Close thread</strong> buttons,
        usable by anyone with the Manage Threads permission in that channel.
      </>,
    ],
  },
  {
    platform: 'telegram',
    summary: 'Sends a message (or photo, if the request has a screenshot) via a Telegram bot.',
    steps: [
      <>
        Message{' '}
        <Anchor href="https://t.me/BotFather" target="_blank" rel="noopener">
          @BotFather
        </Anchor>{' '}
        on Telegram, send <Code>/newbot</Code>, and follow the prompts to get a <strong>bot token</strong>.
      </>,
      <>Add the bot to your target group or channel (as an admin, if it's a channel).</>,
      <>
        Get the <strong>chat ID</strong>: send any message in the group, then visit{' '}
        <Code>https://api.telegram.org/bot&lt;token&gt;/getUpdates</Code> in a browser and look for{' '}
        <Code>"chat":{'{'}"id":...{'}'}</Code> — or use a helper bot like{' '}
        <Anchor href="https://t.me/getidsbot" target="_blank" rel="noopener">
          @getidsbot
        </Anchor>
        .
      </>,
      <>Paste the bot token and chat ID into the channel form.</>,
    ],
  },
  {
    platform: 'email',
    summary: 'Sends an email — BYOK, using a credential you add yourself (Postmark, Mailgun, or SMTP).',
    steps: [
      <>
        Add a credential under <strong>Admin → Credentials</strong>, picking your provider:
        <List size="sm" mt={4}>
          <List.Item>
            <strong>Postmark</strong> — create a Server in your{' '}
            <Anchor href="https://postmarkapp.com" target="_blank" rel="noopener">
              Postmark
            </Anchor>{' '}
            account and copy its Server API Token; verify a Sender Signature or domain to send from.
          </List.Item>
          <List.Item>
            <strong>Mailgun</strong> — from your{' '}
            <Anchor href="https://www.mailgun.com" target="_blank" rel="noopener">
              Mailgun
            </Anchor>{' '}
            dashboard, copy your Private API key and the sending domain.
          </List.Item>
          <List.Item>
            <strong>SMTP</strong> — use your mail provider's host, port, username, and password.
          </List.Item>
        </List>
      </>,
      <>
        When adding/editing an <Code>email</Code> channel, set the recipient address and pick the credential you
        just added.
      </>,
    ],
  },
  {
    platform: 'webhook',
    summary: 'POSTs a plain, unformatted JSON body — for wiring up your own integrations.',
    steps: [
      <>Point Webhook URL at any endpoint you control that accepts a POST with a JSON body.</>,
      <>
        The body looks like:
        <Code block mt={4}>
          {`{
  "title": "Downlock Request — South Africa",
  "prefix": "L5ZA",
  "permalink": "https://www.waze.com/editor?...",
  "lock_level": 5,
  "notes": "Speed limit needs adjusting",
  "submitted_by": "waze_editor",
  "submitted_by_url": "https://www.waze.com/user/editor/waze_editor",
  "editor_rank": 4
}`}
        </Code>
      </>,
    ],
  },
  {
    platform: 'google_sheets',
    summary: 'Appends a row to a Google Sheet via a reusable service account.',
    steps: [
      <>
        In the{' '}
        <Anchor href="https://console.cloud.google.com/" target="_blank" rel="noopener">
          Google Cloud Console
        </Anchor>
        , create (or pick) a project and enable the <strong>Google Sheets API</strong>.
      </>,
      <>Create a Service Account, then create a JSON key for it and download the file.</>,
      <>
        Open your target spreadsheet, click <strong>Share</strong>, and give the service account's{' '}
        <Code>client_email</Code> Editor access.
      </>,
      <>
        In <strong>Admin → Credentials</strong>, add a Google Service Account credential and paste the full JSON key
        file contents.
      </>,
      <>
        When adding/editing a <Code>google_sheets</Code> channel, paste the spreadsheet ID (from the sheet's URL,
        between <Code>/d/</Code> and <Code>/edit</Code>) and pick the credential.
      </>,
      <>
        If the target tab is empty, a header row is added automatically before the first request is appended — no
        setup needed.
      </>,
    ],
  },
  {
    platform: 'google_chat',
    summary: 'Posts a simple text message to a Google Chat space via an incoming webhook.',
    steps: [
      <>
        In Google Chat, open the target Space, click its name, then <strong>Apps &amp; integrations</strong> →{' '}
        <strong>Webhooks</strong>.
      </>,
      <>
        Click <strong>Add a webhook</strong>, name it, and copy the generated URL.
      </>,
      <>
        Paste it into <Code>Webhook URL</Code> when adding a Google Chat channel here.
      </>,
    ],
  },
  {
    platform: 'ntfy',
    summary: 'Sends a push notification to an ntfy topic — works with the public ntfy.sh or a self-hosted server.',
    steps: [
      <>
        Pick a topic name and, optionally, a server. The public{' '}
        <Anchor href="https://ntfy.sh" target="_blank" rel="noopener">
          ntfy.sh
        </Anchor>{' '}
        needs no signup — any unguessable topic name works, e.g. <Code>https://ntfy.sh/wme-au-downlocks-x7f2</Code>.
      </>,
      <>
        Paste the full topic URL into <Code>Topic URL</Code> here.
      </>,
      <>
        If the topic is protected (self-hosted with access control, or a reserved topic on ntfy.sh), also set an{' '}
        <strong>Access Token</strong> — see ntfy's{' '}
        <Anchor href="https://docs.ntfy.sh/publish/#authentication" target="_blank" rel="noopener">
          authentication docs
        </Anchor>
        . Public topics don't need one.
      </>,
      <>Subscribe to the same topic in the ntfy app/website to receive the notifications.</>,
    ],
  },
  {
    platform: 'gotify',
    summary: 'Sends a push notification via a self-hosted Gotify server.',
    steps: [
      <>
        Set up a{' '}
        <Anchor href="https://gotify.net" target="_blank" rel="noopener">
          Gotify
        </Anchor>{' '}
        server (self-hosted — there's no public instance).
      </>,
      <>
        In the Gotify web UI, go to <strong>Apps</strong>, create an application, and copy its <strong>token</strong>.
      </>,
      <>
        Paste your Gotify server's URL into <Code>Server URL</Code> and the app token into{' '}
        <strong>Application Token</strong> here.
      </>,
    ],
  },
]

function Help() {
  return (
    <Container size="md" py="xl">
      <Title order={3} mb={4}>
        Notification Channel Setup
      </Title>
      <Text size="sm" c="dimmed" mb="lg">
        How to configure each notification method, with links to the relevant provider docs. Channels are managed
        under <strong>Admin → Notification Channels</strong>.
      </Text>

      <Stack gap="md">
        {SECTIONS.map((section) => (
          <Card key={section.platform} withBorder radius="md" p="md">
            <Group gap="xs" mb={4}>
              <PlatformBadge platform={section.platform} />
            </Group>
            <Text size="sm" c="dimmed" mb="sm">
              {section.summary}
            </Text>
            <List type="ordered" size="sm" spacing={4}>
              {section.steps.map((step, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <List.Item key={i}>{step}</List.Item>
              ))}
            </List>
          </Card>
        ))}

        <Card withBorder radius="md" p="md">
          <Group gap="xs" mb={4}>
            <Bell size={14} />
            <Text fw={600} size="sm">
              Web Push (browser notifications)
            </Text>
          </Group>
          <Text size="sm" c="dimmed" mb="sm">
            Not a channel an admin configures — any signed-in user can subscribe their own browser directly from the
            dashboard.
          </Text>
          <List type="ordered" size="sm" spacing={4}>
            <List.Item>Sign in, then open the dashboard.</List.Item>
            <List.Item>Pick a country (and optionally a region) in the Filters card, then click "Notify me".</List.Item>
            <List.Item>
              Accept your browser's notification permission prompt. You'll get a native notification whenever a
              matching request comes in, until you remove it from the list shown under Filters.
            </List.Item>
            <List.Item>
              Requires a browser that supports the Push API — all modern desktop and Android browsers; on iOS,
              Safari requires the site to be added to the Home Screen first.
            </List.Item>
          </List>
        </Card>

        <Card withBorder radius="md" p="md">
          <Group gap="xs" mb={4}>
            <Rss size={14} />
            <Text fw={600} size="sm">
              RSS / Atom Feed
            </Text>
          </Group>
          <Text size="sm" c="dimmed" mb="sm">
            A read-only, pull-based alternative to the channels above — no admin setup needed. Subscribe in any
            feed reader instead of receiving pushes. You need to be signed in to get a feed URL.
          </Text>
          <List type="ordered" size="sm" spacing={4}>
            <List.Item>
              On the dashboard, pick a country (and optionally a region or type), then click{' '}
              <strong>Copy Feed URL</strong> — it copies a link like{' '}
              <Code>/api/feed?token=…&amp;country_id=3&amp;type=downlock</Code> to your clipboard.
            </List.Item>
            <List.Item>Paste that URL into your feed reader of choice.</List.Item>
            <List.Item>
              The <Code>token</Code> is private to you — treat the URL like a password. The feed only ever includes
              requests from the countries you're assigned to; leave off <Code>country_id</Code> (don't select a
              country before copying) for a feed covering all of them.
            </List.Item>
            <List.Item>
              If a feed URL leaks, use <strong>Reset feed URL</strong> (the arrow next to Copy Feed URL). Every
              previously copied URL stops working immediately, so re-copy it into your reader.
            </List.Item>
            <List.Item>The feed is standard RSS 2.0 and updates as soon as new requests come in — no polling delay beyond your reader's own refresh interval.</List.Item>
          </List>
        </Card>

        <Card withBorder radius="md" p="md">
          <Group gap="xs" mb={4}>
            <ShieldCheck size={14} />
            <Text fw={600} size="sm">
              Your WMEKit account
            </Text>
          </Group>
          <Text size="sm" c="dimmed" mb="sm">
            You sign in to WME Requests with your WMEKit account at <strong>auth.wmekit.com</strong> — the same
            account works for WME Sync and other WMEKit apps.
          </Text>
          <List type="ordered" size="sm" spacing={4}>
            <List.Item>
              Your password, passkeys, connected Discord account, two-factor authentication and recent security activity
              are all managed there: open the profile menu and choose <strong>WMEKit account</strong>.
            </List.Item>
            <List.Item>
              Having an account isn't enough on its own: a global admin adds you to WME Requests and picks which
              countries you can see. Until then you'll see "Ask an admin for access".
            </List.Item>
            <List.Item>
              WazeTools is now WMEKit. Passkeys and security keys were tied to the old wazetools.com address, so
              any you added before the move need adding again on your WMEKit account. Your password, Discord
              sign-in and authenticator app carried over.
            </List.Item>
          </List>
        </Card>
      </Stack>
    </Container>
  )
}
