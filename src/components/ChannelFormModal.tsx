import { useEffect, useState } from 'react'
import { Button, Checkbox, Code, Group, Loader, Modal, Select, Stack, Text, TextInput } from '@mantine/core'
import { Plus } from 'lucide-react'
import { useForm } from '@mantine/form'
import {
  useCreateChannel,
  useCredentials,
  useDiscordGuildChannels,
  useDiscordGuilds,
  useRegions,
  useUpdateChannel,
  type ChannelFormValues,
} from '@/lib/queries'
import type { Channel, DiscordGuildChannel } from '@/lib/types'
import CredentialsModal from '@/components/CredentialsModal'
import VariableTextInput from '@/components/VariableTextInput'
import { CUSTOM_PREFIX_VARIABLES } from '@/lib/templateVariables'

interface Props {
  opened: boolean
  onClose: () => void
  countryId: string
  channel?: Channel | null
}

const PLATFORM_OPTIONS = [
  { value: 'slack', label: 'Slack' },
  { value: 'slack_threaded', label: 'Slack (Threaded)' },
  { value: 'discord', label: 'Discord' },
  { value: 'discord_bot', label: 'Discord (Bot)' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'email', label: 'Email' },
  { value: 'webhook', label: 'Webhook (generic JSON)' },
  { value: 'google_sheets', label: 'Google Sheet' },
  { value: 'google_chat', label: 'Google Chat' },
  { value: 'ntfy', label: 'ntfy' },
  { value: 'gotify', label: 'Gotify' },
]

const EVENT_TYPE_OPTIONS = [
  { value: 'global', label: 'Global (all requests)' },
  { value: 'downlock', label: 'Downlock only' },
  { value: 'uplock', label: 'Uplock only' },
  { value: 'imagery', label: 'Imagery only' },
  { value: 'accept_pur', label: 'Accept PUR only' },
  { value: 'decline_pur', label: 'Decline PUR only' },
]

const EMPTY_VALUES: ChannelFormValues = {
  label: '',
  platform: 'slack',
  event_type: 'global',
  region_id: null,
  webhook_url: '',
  bot_token: '',
  chat_id: '',
  custom_prefix: '',
  email_to: '',
  discord_forum: false,
  spreadsheet_id: '',
  sheet_name: '',
  google_credential_id: null,
  email_credential_id: null,
  discord_guild_id: null,
  discord_channel_id: null,
  discord_threaded: false,
}

// Select data for a Discord server's channels: uncategorised ones first, then one group per
// category, in Discord's own order (the API already sorts them that way).
function discordChannelOptions(channels: DiscordGuildChannel[]) {
  const option = (c: DiscordGuildChannel) => ({
    value: c.id,
    label: `#${c.name}${c.type === 15 ? ' (forum)' : ''}`,
  })
  const groups = new Map<string, ReturnType<typeof option>[]>()
  const ungrouped: ReturnType<typeof option>[] = []
  for (const c of channels) {
    if (!c.parentName) ungrouped.push(option(c))
    else groups.set(c.parentName, [...(groups.get(c.parentName) ?? []), option(c)])
  }
  return [...ungrouped, ...[...groups].map(([group, items]) => ({ group, items }))]
}

export default function ChannelFormModal({ opened, onClose, countryId, channel }: Readonly<Props>) {
  const isEdit = !!channel
  const create = useCreateChannel()
  const update = useUpdateChannel()
  const regionsQuery = useRegions(countryId)
  const regions = regionsQuery.data ?? []
  const googleCredentialsQuery = useCredentials('google_service_account')
  const emailCredentialsQuery = useCredentials()
  const emailCredentials = (emailCredentialsQuery.data ?? []).filter((c) => c.type.startsWith('email_'))
  const [addCredentialKind, setAddCredentialKind] = useState<'google' | 'email' | null>(null)

  const form = useForm<ChannelFormValues>({
    initialValues: EMPTY_VALUES,
    validate: {
      label: (v) => (v.trim() ? null : 'Label is required'),
      webhook_url: (v, values) =>
        (values.platform === 'slack' ||
          values.platform === 'discord' ||
          values.platform === 'webhook' ||
          values.platform === 'google_chat' ||
          values.platform === 'ntfy' ||
          values.platform === 'gotify') &&
        !v
          ? 'URL is required'
          : null,
      bot_token: (v, values) => {
        if (values.platform === 'telegram' && !v) return 'Bot token is required'
        if (values.platform === 'slack_threaded' && !v) return 'Bot token is required'
        if (values.platform === 'gotify' && !v) return 'Application token is required'
        return null
      },
      chat_id: (v, values) =>
        (values.platform === 'telegram' || values.platform === 'slack_threaded') && !v ? 'Channel ID is required' : null,
      email_to: (v, values) => (values.platform === 'email' && !v ? 'Recipient email is required' : null),
      spreadsheet_id: (v, values) =>
        values.platform === 'google_sheets' && !v ? 'Spreadsheet ID is required' : null,
      google_credential_id: (v, values) =>
        values.platform === 'google_sheets' && !v ? 'A Google credential is required' : null,
      email_credential_id: (v, values) => (values.platform === 'email' && !v ? 'An email credential is required' : null),
      discord_guild_id: (v, values) => (values.platform === 'discord_bot' && !v ? 'Pick a Discord server' : null),
      discord_channel_id: (v, values) => (values.platform === 'discord_bot' && !v ? 'Pick a channel' : null),
    },
  })

  useEffect(() => {
    if (opened) {
      form.setValues(
        channel
          ? {
              label: channel.label,
              platform: channel.platform,
              event_type: channel.event_type,
              region_id: channel.region_id,
              webhook_url: channel.webhook_url ?? '',
              bot_token: channel.bot_token ?? '',
              chat_id: channel.chat_id ?? '',
              custom_prefix: channel.custom_prefix ?? '',
              email_to: channel.email_to ?? '',
              discord_forum: !!channel.discord_forum,
              spreadsheet_id: channel.spreadsheet_id ?? '',
              sheet_name: channel.sheet_name ?? '',
              google_credential_id: channel.google_credential_id,
              email_credential_id: channel.email_credential_id,
              discord_guild_id: channel.discord_guild_id,
              discord_channel_id: channel.discord_channel_id,
              discord_threaded: !!channel.discord_threaded,
            }
          : EMPTY_VALUES,
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, channel])

  // Only fetched while the Discord (Bot) platform is selected.
  const discordGuildsQuery = useDiscordGuilds(countryId, opened && form.values.platform === 'discord_bot')
  const discordGuilds = discordGuildsQuery.data ?? []
  const discordChannelsQuery = useDiscordGuildChannels(
    countryId,
    opened && form.values.platform === 'discord_bot' ? form.values.discord_guild_id : null,
  )

  async function handleSubmit(values: ChannelFormValues) {
    const usesWebhookUrl =
      values.platform === 'slack' ||
      values.platform === 'discord' ||
      values.platform === 'webhook' ||
      values.platform === 'google_chat' ||
      values.platform === 'ntfy' ||
      values.platform === 'gotify'
    const usesBotToken =
      values.platform === 'telegram' ||
      values.platform === 'slack_threaded' ||
      values.platform === 'ntfy' ||
      values.platform === 'gotify'
    const usesChatId = values.platform === 'telegram' || values.platform === 'slack_threaded'
    const payload: ChannelFormValues = {
      label: values.label.trim(),
      platform: values.platform,
      event_type: values.event_type,
      region_id: values.region_id,
      webhook_url: usesWebhookUrl ? values.webhook_url?.trim() || null : null,
      bot_token: usesBotToken ? values.bot_token?.trim() || null : null,
      chat_id: usesChatId ? values.chat_id?.trim() || null : null,
      custom_prefix: values.custom_prefix?.trim() || null,
      email_to: values.platform === 'email' ? values.email_to?.trim() || null : null,
      discord_forum: values.platform === 'discord' ? values.discord_forum : false,
      spreadsheet_id: values.platform === 'google_sheets' ? values.spreadsheet_id?.trim() || null : null,
      sheet_name: values.platform === 'google_sheets' ? values.sheet_name?.trim() || null : null,
      google_credential_id: values.platform === 'google_sheets' ? values.google_credential_id : null,
      email_credential_id: values.platform === 'email' ? values.email_credential_id : null,
      discord_guild_id: values.platform === 'discord_bot' ? values.discord_guild_id : null,
      discord_channel_id: values.platform === 'discord_bot' ? values.discord_channel_id : null,
      discord_threaded: values.platform === 'discord_bot' ? values.discord_threaded : false,
    }
    try {
      if (isEdit && channel) {
        await update.mutateAsync({ id: channel.id, countryId, ...payload })
      } else {
        await create.mutateAsync({ countryId, ...payload })
      }
      onClose()
    } catch (e) {
      form.setFieldError('label', (e as Error).message)
    }
  }

  const platform = form.values.platform
  const isTelegram = platform === 'telegram'
  const isSlackThreaded = platform === 'slack_threaded'
  const isEmail = platform === 'email'
  const isWebhook = platform === 'webhook'
  const isDiscord = platform === 'discord'
  const isDiscordBot = platform === 'discord_bot'
  const isGoogleChat = platform === 'google_chat'
  const isGoogleSheets = platform === 'google_sheets'
  const isNtfy = platform === 'ntfy'
  const isGotify = platform === 'gotify'
  const showWebhookUrl = platform === 'slack' || isDiscord || isWebhook || isGoogleChat || isNtfy || isGotify
  const webhookUrlLabel = isNtfy ? 'Topic URL' : isGotify ? 'Server URL' : 'Webhook URL'
  const webhookUrlPlaceholder = isWebhook
    ? 'https://your-service.example.com/hook'
    : isGoogleChat
      ? 'https://chat.googleapis.com/v1/spaces/…'
      : isNtfy
        ? 'https://ntfy.sh/your-topic'
        : isGotify
          ? 'https://gotify.example.com'
          : 'https://hooks.slack.com/…'
  const saving = create.isPending || update.isPending

  return (
    <>
      <Modal
        opened={opened}
        onClose={onClose}
        title={isEdit ? 'Edit Notification Channel' : 'Add Notification Channel'}
        closeOnClickOutside={!saving}
        closeOnEscape={!saving}
      >
        <form onSubmit={form.onSubmit(handleSubmit)}>
          <Stack>
            <TextInput
              label="Label"
              placeholder="e.g. #wme-au-downlocks"
              disabled={saving}
              {...form.getInputProps('label')}
            />
            <Select
              label="Platform"
              data={PLATFORM_OPTIONS}
              allowDeselect={false}
              disabled={saving}
              {...form.getInputProps('platform')}
            />
            <Select
              label="Event Type"
              data={EVENT_TYPE_OPTIONS}
              allowDeselect={false}
              disabled={saving}
              {...form.getInputProps('event_type')}
            />
            <Select
              label="Region"
              placeholder="Country-wide (all regions)"
              description="Scopes this channel to one region. Requests in a region with no matching channels fall back to the country-wide ones."
              data={regions.map((r) => ({ value: String(r.id), label: `${r.name} (${r.code})` }))}
              value={form.values.region_id != null ? String(form.values.region_id) : null}
              onChange={(v) => form.setFieldValue('region_id', v ? Number(v) : null)}
              disabled={saving || !regions.length}
              clearable
            />
            {showWebhookUrl && (
              <TextInput
                label={webhookUrlLabel}
                placeholder={webhookUrlPlaceholder}
                description={isWebhook ? 'Receives a POST with a plain JSON body on every matching request.' : undefined}
                disabled={saving}
                {...form.getInputProps('webhook_url')}
              />
            )}
            {isNtfy && (
              <TextInput
                label="Access Token (optional)"
                placeholder="tk_…"
                description="Only needed if the topic is protected — public topics don't require one."
                disabled={saving}
                {...form.getInputProps('bot_token')}
              />
            )}
            {isGotify && (
              <TextInput
                label="Application Token"
                placeholder="A…"
                disabled={saving}
                {...form.getInputProps('bot_token')}
              />
            )}
            {isDiscord && (
              <Checkbox
                label="Post as a new thread in a Discord Forum channel"
                description="The webhook must point at a Forum channel. Each notification creates a new forum post — Discord doesn't support posting further replies into it via webhook."
                disabled={saving}
                {...form.getInputProps('discord_forum', { type: 'checkbox' })}
              />
            )}
            {isDiscordBot && (
              <>
                <Text size="xs" c="dimmed">
                  Posts as the WME Requests bot — no webhook needed. Click <strong>Add bot</strong> to add it to your Discord
                  server (you need the Manage Server permission there), then come back to this tab and pick the channel.
                </Text>
                <Group align="flex-end">
                  <Select
                    flex={1}
                    label="Discord Server"
                    placeholder={discordGuilds.length ? 'Select a server…' : 'Add the bot to a server first'}
                    data={discordGuilds.map((g) => ({ value: g.guild_id, label: g.guild_name }))}
                    value={form.values.discord_guild_id}
                    onChange={(v) => {
                      form.setFieldValue('discord_guild_id', v)
                      form.setFieldValue('discord_channel_id', null)
                    }}
                    error={form.errors.discord_guild_id}
                    disabled={saving || !discordGuilds.length}
                  />
                  <Button
                    component="a"
                    href={`/api/discord/install?country_id=${countryId}`}
                    target="_blank"
                    rel="noopener"
                    title="Add the bot to a Discord server (opens in a new tab)"
                    variant="light"
                    leftSection={<Plus size={14} />}
                    disabled={saving}
                  >
                    Add bot
                  </Button>
                </Group>
                <Select
                  label="Discord Channel"
                  placeholder={form.values.discord_guild_id ? 'Select a channel…' : 'Select a server first'}
                  description="Text, announcement or forum channels. In a forum, each notification is a new post."
                  data={discordChannelOptions(discordChannelsQuery.data ?? [])}
                  searchable
                  value={form.values.discord_channel_id}
                  onChange={(v) => form.setFieldValue('discord_channel_id', v)}
                  error={
                    form.errors.discord_channel_id ||
                    (discordChannelsQuery.error ? discordChannelsQuery.error.message : undefined)
                  }
                  rightSection={discordChannelsQuery.isFetching ? <Loader size="xs" /> : undefined}
                  disabled={saving || !form.values.discord_guild_id}
                />
                <Checkbox
                  label="Thread requests from the same submitter"
                  description="Consecutive requests from the same submitter on the same day reply in one thread instead of posting separately — in a forum, as replies to the first request's post. Each request gets Complete, Reject and Close thread buttons for anyone with Manage Threads."
                  disabled={saving}
                  {...form.getInputProps('discord_threaded', { type: 'checkbox' })}
                />
              </>
            )}
            {isGoogleSheets && (
              <>
                <TextInput
                  label="Spreadsheet ID"
                  placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
                  description="The long ID in the sheet's URL, between /d/ and /edit."
                  disabled={saving}
                  {...form.getInputProps('spreadsheet_id')}
                />
                <TextInput
                  label="Sheet / Tab Name (optional)"
                  placeholder="Sheet1"
                  description="Defaults to Sheet1 if left blank."
                  disabled={saving}
                  {...form.getInputProps('sheet_name')}
                />
                <Group align="flex-end">
                  <Select
                    flex={1}
                    label="Google Service Account"
                    placeholder="Select a credential…"
                    description="Reusable across any channel. Share the sheet (Editor access) with its client_email."
                    data={(googleCredentialsQuery.data ?? []).map((c) => ({
                      value: String(c.id),
                      label: `${c.label} (${c.display_identifier})`,
                    }))}
                    value={form.values.google_credential_id != null ? String(form.values.google_credential_id) : null}
                    onChange={(v) => form.setFieldValue('google_credential_id', v ? Number(v) : null)}
                    error={form.errors.google_credential_id}
                    disabled={saving}
                  />
                  <Button
                    variant="light"
                    leftSection={<Plus size={14} />}
                    onClick={() => setAddCredentialKind('google')}
                    disabled={saving}
                  >
                    Add
                  </Button>
                </Group>
              </>
            )}
            {isWebhook && (
              <div>
                <Text size="sm" fw={500} mb={4}>
                  Example payload
                </Text>
                <Code block>
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
                <Text size="xs" c="dimmed" mt={4}>
                  <code>prefix</code>, <code>lock_level</code>, <code>notes</code>, <code>submitted_by</code>,{' '}
                  <code>submitted_by_url</code>, and <code>editor_rank</code> are <code>null</code> when not
                  applicable (e.g. <code>lock_level</code> for imagery requests).
                </Text>
              </div>
            )}
            {isTelegram && (
              <>
                <TextInput
                  label="Bot Token"
                  placeholder="123456:ABC-…"
                  disabled={saving}
                  {...form.getInputProps('bot_token')}
                />
                <TextInput
                  label="Chat ID"
                  placeholder="-100123456789"
                  disabled={saving}
                  {...form.getInputProps('chat_id')}
                />
              </>
            )}
            {isSlackThreaded && (
              <>
                <Text size="xs" c="dimmed">
                  Uses a Slack app's bot token instead of an incoming webhook, so consecutive requests from the
                  same submitter on the same day can reply into one thread instead of posting separately. Needs a
                  Slack app with the <Code>chat:write</Code> scope, installed to the workspace and invited to the
                  channel.
                </Text>
                <TextInput
                  label="Bot Token"
                  placeholder="xoxb-…"
                  disabled={saving}
                  {...form.getInputProps('bot_token')}
                />
                <TextInput
                  label="Channel ID"
                  placeholder="C0123456789"
                  description="The channel's ID (right-click the channel → View channel details), not its name."
                  disabled={saving}
                  {...form.getInputProps('chat_id')}
                />
              </>
            )}
            {isEmail && (
              <>
                <TextInput
                  label="Recipient Email"
                  type="email"
                  placeholder="alerts@example.com"
                  disabled={saving}
                  {...form.getInputProps('email_to')}
                />
                <Group align="flex-end">
                  <Select
                    flex={1}
                    label="Email Credential"
                    placeholder="Select a credential…"
                    description="Your own Postmark, Mailgun, or SMTP credential — bring your own key."
                    data={emailCredentials.map((c) => ({
                      value: String(c.id),
                      label: `${c.label} (${c.display_identifier})`,
                    }))}
                    value={form.values.email_credential_id != null ? String(form.values.email_credential_id) : null}
                    onChange={(v) => form.setFieldValue('email_credential_id', v ? Number(v) : null)}
                    error={form.errors.email_credential_id}
                    disabled={saving}
                  />
                  <Button
                    variant="light"
                    leftSection={<Plus size={14} />}
                    onClick={() => setAddCredentialKind('email')}
                    disabled={saving}
                  >
                    Add
                  </Button>
                </Group>
              </>
            )}
            <VariableTextInput
              label="Custom Prefix (optional)"
              placeholder="e.g. L{lock_level}{country_code}"
              description="Prepended before the permalink on every message. Use the { } button to insert a variable."
              disabled={saving}
              variables={CUSTOM_PREFIX_VARIABLES}
              autosize
              minRows={1}
              maxRows={4}
              {...form.getInputProps('custom_prefix')}
            />
            <Group justify="flex-end">
              <Button variant="default" type="button" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                Save
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
      <CredentialsModal
        opened={!!addCredentialKind}
        kind={addCredentialKind ?? 'email'}
        onClose={() => setAddCredentialKind(null)}
      />
    </>
  )
}
