import { Fragment, useState, type CSSProperties, type ReactNode } from 'react'
import { Anchor, Badge, Code, Group, SegmentedControl, Select, Stack, Table, Text } from '@mantine/core'
import type { ChannelFormValues } from '@/lib/queries'
import type { DiscordGuildEmoji, DiscordGuildRole, RequestType } from '@/lib/types'
import {
  GOOGLE_SHEET_HEADERS,
  LOCK_GATED_TYPES,
  TYPE_META,
  applyPrefixTemplate,
  buildDiscordPayload,
  buildEmail,
  buildGoogleChatText,
  buildPlainNotification,
  buildSheetRow,
  buildSlackPayload,
  buildTelegramText,
  buildWebhookBody,
  discordBotContent,
  discordLockEmoji,
  discordThreadName,
  hexColor,
  type NotificationMessage,
  type PrefixVars,
  type SlackBlock,
} from '@/lib/notification-format'

// Live preview of a channel's notifications, built from the unsaved form values with the same
// formatters the senders use (src/lib/notification-format.ts), then drawn to look roughly like
// each platform. Sample request data only — nothing is sent.

interface Props {
  values: ChannelFormValues
  countryName: string
  countryCode: string
  regionName: string | null
  regionCode: string | null
  discordRoles: DiscordGuildRole[]
  discordEmojis: DiscordGuildEmoji[]
  // discord_bot: whether the picked channel is a forum (each notification is a new post).
  discordChannelIsForum: boolean
}

const ALL_TYPES: RequestType[] = ['downlock', 'uplock', 'imagery', 'accept_pur', 'decline_pur']

const SAMPLE_NOTES: Record<RequestType, string> = {
  downlock: 'Speed limit on this segment needs updating',
  uplock: 'Junction reviewed and fixed — please lock',
  imagery: 'New road is open but the satellite imagery is outdated',
  accept_pur: 'Business confirmed open at this address',
  decline_pur: 'Duplicate of an existing place',
}

const SAMPLE_SUBMITTER = 'SampleEditor'
const SAMPLE_RANK = 3
const SAMPLE_PERMALINK = 'https://www.waze.com/editor?env=row&lat=-26.20410&lon=28.04730&zoomLevel=17'

export default function ChannelPreview({
  values,
  countryName,
  countryCode,
  regionName,
  regionCode,
  discordRoles,
  discordEmojis,
  discordChannelIsForum,
}: Readonly<Props>) {
  const types = values.event_type === 'global' ? ALL_TYPES : [values.event_type as RequestType]
  const [pickedType, setPickedType] = useState<RequestType>(types[0])
  const [lockLevel, setLockLevel] = useState('5')
  const type = types.includes(pickedType) ? pickedType : types[0]
  const lockGated = LOCK_GATED_TYPES.has(type)

  const place = regionName ? `${regionName}, ${countryName}` : countryName
  const msg: NotificationMessage = {
    requestId: 1,
    title: `${TYPE_META[type].label} — ${place}`,
    color: TYPE_META[type].color,
    permalink: SAMPLE_PERMALINK,
    lockLevel: lockGated ? Number(lockLevel) : null,
    notes: SAMPLE_NOTES[type],
    submittedBy: SAMPLE_SUBMITTER,
    editorRank: SAMPLE_RANK,
    screenshotUrl: null,
  }
  const vars: PrefixVars = {
    country_code: countryCode,
    country_name: countryName,
    region_code: regionCode || '',
    region_name: regionName || '',
    lock_level: lockGated ? lockLevel : '',
    editor_rank: String(SAMPLE_RANK),
    type,
    submitted_by: SAMPLE_SUBMITTER,
  }
  const prefix = values.custom_prefix?.trim() ? applyPrefixTemplate(values.custom_prefix.trim(), vars) : null

  return (
    <Stack gap="sm">
      <Group align="flex-end" gap="sm">
        {types.length > 1 && (
          <SegmentedControl
            size="xs"
            value={type}
            onChange={(v) => setPickedType(v as RequestType)}
            data={types.map((t) => ({ value: t, label: TYPE_META[t].label.replace(' Request', '') }))}
          />
        )}
        {lockGated && (
          <Select
            size="xs"
            w={90}
            aria-label="Lock level"
            data={['1', '2', '3', '4', '5', '6', '7'].map((l) => ({ value: l, label: `L${l}` }))}
            value={lockLevel}
            onChange={(v) => v && setLockLevel(v)}
            allowDeselect={false}
          />
        )}
      </Group>
      <PlatformPreview
        values={values}
        msg={msg}
        vars={vars}
        prefix={prefix}
        discordRoles={discordRoles}
        discordEmojis={discordEmojis}
        discordChannelIsForum={discordChannelIsForum}
      />
      <Text size="xs" c="dimmed">
        Sample request data — the real look depends on each app&apos;s theme. Screenshots, when the submitter
        attaches one, show below the message.
      </Text>
    </Stack>
  )
}

function PlatformPreview({
  values,
  msg,
  vars,
  prefix,
  discordRoles,
  discordEmojis,
  discordChannelIsForum,
}: Readonly<{
  values: ChannelFormValues
  msg: NotificationMessage
  vars: PrefixVars
  prefix: string | null
  discordRoles: DiscordGuildRole[]
  discordEmojis: DiscordGuildEmoji[]
  discordChannelIsForum: boolean
}>) {
  const today = new Date().toISOString().slice(0, 10)
  switch (values.platform) {
    case 'discord': {
      const payload = buildDiscordPayload(msg, prefix)
      return (
        <DiscordMessage
          content={payload.content ?? null}
          embed={payload.embeds[0]}
          postTitle={values.discord_forum ? (prefix || msg.title).slice(0, 100) : null}
          roles={discordRoles}
          name="Webhook"
        />
      )
    }
    case 'discord_bot': {
      const emojiById = new Map(discordEmojis.map((e) => [e.id, e]))
      const lockEmojis = Object.fromEntries(
        Object.entries(values.discord_lock_emojis).flatMap(([level, id]) => {
          const emoji = id ? emojiById.get(id) : undefined
          return emoji ? [[level, emoji]] : []
        }),
      )
      const lockEmoji = discordLockEmoji(JSON.stringify(lockEmojis), msg.lockLevel)
      const content = discordBotContent(values.discord_role_ids.join(',') || null, lockEmoji, prefix)
      const payload = buildDiscordPayload(msg, content, lockEmoji)
      const title = values.discord_thread_title?.trim() || null
      return (
        <Stack gap={4}>
          {values.discord_threaded && !discordChannelIsForum && (
            <Text size="xs" c="dimmed">
              A second request from the same submitter today starts a thread on this message named{' '}
              <strong>{discordThreadName(title, vars, today, `Requests from ${SAMPLE_SUBMITTER} — ${today}`)}</strong>.
            </Text>
          )}
          <DiscordMessage
            content={payload.content ?? null}
            embed={payload.embeds[0]}
            postTitle={discordChannelIsForum ? discordThreadName(title, vars, today, prefix || msg.title) : null}
            roles={discordRoles}
            name="WME Requests"
            buttons={values.discord_threaded}
          />
        </Stack>
      )
    }
    case 'slack':
    case 'slack_threaded':
      return <SlackMessage payload={buildSlackPayload(msg, prefix)} />
    case 'google_chat':
      return (
        <Card style={{ background: '#fff', color: '#1f1f1f' }}>
          <SenderLine name="WME Requests" />
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{renderRich(buildGoogleChatText(msg, prefix), SLACK_RULES)}</div>
        </Card>
      )
    case 'telegram':
      return (
        <div style={{ background: '#8fb184', padding: 12, borderRadius: 8 }}>
          <div style={{ background: '#fff', color: '#000', padding: '8px 12px', borderRadius: 12, maxWidth: 440, fontSize: 14 }}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{renderRich(buildTelegramText(msg, prefix), TELEGRAM_RULES, unescapeTelegram)}</div>
          </div>
        </div>
      )
    case 'ntfy':
    case 'gotify': {
      const n = buildPlainNotification(msg, prefix)
      return (
        <Card style={{ background: '#fff', color: '#1f1f1f', boxShadow: '0 1px 4px rgba(0,0,0,.15)' }}>
          <Text size="xs" c="dimmed">
            {values.platform === 'ntfy' ? 'ntfy' : 'Gotify'} · now
          </Text>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{n.title}</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{n.message}</div>
        </Card>
      )
    }
    case 'email': {
      const email = buildEmail(msg, prefix)
      return (
        <Stack gap={4}>
          <Text size="sm">
            <strong>Subject:</strong> {email.subject}
          </Text>
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={`<body style="font-family:system-ui,sans-serif;font-size:14px;margin:12px;color:#1a1b1e;background:#fff">${email.htmlBody}</body>`}
            style={{ width: '100%', height: 260, border: '1px solid var(--mantine-color-default-border)', borderRadius: 6 }}
          />
        </Stack>
      )
    }
    case 'webhook':
      return <Code block>{JSON.stringify(buildWebhookBody(msg, prefix), null, 2)}</Code>
    case 'google_sheets': {
      const row = buildSheetRow(msg, vars, new Date().toISOString())
      return (
        <Table.ScrollContainer minWidth={900}>
          <Table withTableBorder withColumnBorders fz="xs">
            <Table.Thead>
              <Table.Tr>
                {GOOGLE_SHEET_HEADERS.map((h) => (
                  <Table.Th key={h}>{h}</Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <Table.Tr>
                {row.map((cell, i) => (
                  <Table.Td key={GOOGLE_SHEET_HEADERS[i]}>{String(cell)}</Table.Td>
                ))}
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )
    }
    default:
      return null
  }
}

function Card({ style, children }: Readonly<{ style?: CSSProperties; children: ReactNode }>) {
  return <div style={{ padding: 12, borderRadius: 8, border: '1px solid #e0e0e0', ...style }}>{children}</div>
}

function SenderLine({ name, badge, color }: Readonly<{ name: string; badge?: string; color?: string }>) {
  return (
    <Group gap={6} mb={2}>
      <span style={{ fontWeight: 600, fontSize: 14, color }}>{name}</span>
      {badge && (
        <Badge size="xs" radius="sm" color="indigo" variant="filled">
          {badge}
        </Badge>
      )}
      <span style={{ fontSize: 11, opacity: 0.6 }}>Today at {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </Group>
  )
}

// --- Inline markup ---------------------------------------------------------------------------

interface Rule {
  re: RegExp
  render: (m: RegExpExecArray, key: string, leaf: (t: string) => string) => ReactNode
}

// Splits text on the earliest-matching rule, recursively — enough for the handful of markup
// forms the formatters produce (links, bold, mentions, custom emoji).
function renderRich(text: string, rules: Rule[], leaf: (t: string) => string = (t) => t, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let n = 0
  while (rest) {
    let best: { m: RegExpExecArray; rule: Rule } | null = null
    for (const rule of rules) {
      const m = new RegExp(rule.re.source, rule.re.flags.replace('g', '')).exec(rest)
      if (m && (!best || m.index < best.m.index)) best = { m, rule }
    }
    if (!best) {
      out.push(leaf(rest))
      break
    }
    if (best.m.index > 0) out.push(leaf(rest.slice(0, best.m.index)))
    out.push(<Fragment key={`${keyPrefix}${n++}`}>{best.rule.render(best.m, `${keyPrefix}${n}-`, leaf)}</Fragment>)
    rest = rest.slice(best.m.index + best.m[0].length)
  }
  return out
}

const link = (href: string, label: ReactNode, color: string) => (
  <Anchor href={href} target="_blank" rel="noopener noreferrer" style={{ color }} fz="inherit">
    {label}
  </Anchor>
)

const SLACK_RULES: Rule[] = [
  { re: /<(https?:\/\/[^|>]+)\|([^>]+)>/, render: (m) => link(m[1], m[2], '#1264a3') },
  { re: /\*([^*\n]+)\*/, render: (m, key) => <strong>{renderRich(m[1], SLACK_RULES, undefined, key)}</strong> },
]

const TELEGRAM_RULES: Rule[] = [
  {
    re: /\[((?:\\.|[^\]\\])+)\]\(((?:\\.|[^)\\])+)\)/,
    render: (m, _key, leaf) => link(leaf(m[2]), leaf(m[1]), '#168acd'),
  },
  {
    re: /\*((?:\\.|[^*\\])+)\*/,
    render: (m, key, leaf) => <strong>{renderRich(m[1], TELEGRAM_RULES, leaf, key)}</strong>,
  },
]

function unescapeTelegram(text: string) {
  return text.replace(/\\(.)/g, '$1')
}

function discordRules(roles: DiscordGuildRole[]): Rule[] {
  const roleById = new Map(roles.map((r) => [r.id, r]))
  const rules: Rule[] = [
    {
      re: /<(a?):(\w+):(\d+)>/,
      render: (m) => (
        <img
          src={`https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? 'gif' : 'webp'}?size=48`}
          alt={`:${m[2]}:`}
          title={`:${m[2]}:`}
          style={{ width: 22, height: 22, objectFit: 'contain', verticalAlign: 'middle' }}
        />
      ),
    },
    {
      re: /<@&(\d+)>/,
      render: (m) => {
        const role = roleById.get(m[1])
        const color = role?.color ? hexColor(role.color) : '#c9cdfb'
        return (
          <span style={{ background: 'rgba(88,101,242,.3)', color, borderRadius: 3, padding: '0 2px', fontWeight: 500 }}>
            @{role?.name ?? 'unknown-role'}
          </span>
        )
      },
    },
    { re: /@(everyone|here)\b/, render: (m) => <span style={{ background: 'rgba(88,101,242,.3)', color: '#c9cdfb', borderRadius: 3, padding: '0 2px' }}>@{m[1]}</span> },
    { re: /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/, render: (m) => link(m[2], m[1], '#00a8fc') },
    { re: /\*\*(.+?)\*\*/, render: (m, key) => <strong>{renderRich(m[1], rules, undefined, key)}</strong> },
    { re: /https?:\/\/\S+/, render: (m) => link(m[0], m[0], '#00a8fc') },
  ]
  return rules
}

// --- Discord ---------------------------------------------------------------------------------

function DiscordMessage({
  content,
  embed,
  postTitle,
  roles,
  name,
  buttons,
}: Readonly<{
  content: string | null
  embed: { title: string; description: string; color: number }
  postTitle: string | null
  roles: DiscordGuildRole[]
  name: string
  buttons?: boolean
}>) {
  const rules = discordRules(roles)
  const button = (label: string, background: string) => (
    <span style={{ background, color: '#fff', borderRadius: 4, padding: '4px 12px', fontSize: 13, fontWeight: 500 }}>
      {label}
    </span>
  )
  return (
    <div style={{ background: '#313338', color: '#dbdee1', padding: 12, borderRadius: 8, fontSize: 14 }}>
      {postTitle && (
        <div style={{ fontWeight: 700, fontSize: 18, color: '#f2f3f5', marginBottom: 8 }}>
          {postTitle}
          <Text span size="xs" c="dimmed" ml={6} fw={400}>
            (forum post title)
          </Text>
        </div>
      )}
      <SenderLine name={name} badge="APP" color="#f2f3f5" />
      {content && <div style={{ whiteSpace: 'pre-wrap', marginBottom: 4 }}>{renderRich(content, rules)}</div>}
      <div
        style={{
          background: '#2b2d31',
          borderLeft: `4px solid ${hexColor(embed.color)}`,
          borderRadius: 4,
          padding: '8px 12px 12px',
          maxWidth: 520,
        }}
      >
        <div style={{ fontWeight: 600, color: '#f2f3f5', marginBottom: 4 }}>{embed.title}</div>
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{renderRich(embed.description, rules)}</div>
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>Today at {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
      {buttons && (
        <Group gap={8} mt={8}>
          {button('Complete', '#248046')}
          {button('Reject', '#da373c')}
          {button('🔒 Close thread', '#4e5058')}
        </Group>
      )}
    </div>
  )
}

// --- Slack -----------------------------------------------------------------------------------

function SlackMessage({ payload }: Readonly<{ payload: ReturnType<typeof buildSlackPayload> }>) {
  const attachment = payload.attachments[0]
  const block = (b: SlackBlock, i: number) => {
    if (b.type === 'image') return <img key={i} src={b.image_url} alt={b.alt_text} style={{ maxWidth: '100%' }} />
    return (
      <div key={i} style={{ marginBottom: 6 }}>
        {b.text && <div style={{ whiteSpace: 'pre-wrap' }}>{renderRich(b.text.text, SLACK_RULES)}</div>}
        {b.fields && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
            {b.fields.map((f, j) => (
              <div key={j} style={{ whiteSpace: 'pre-wrap' }}>
                {renderRich(f.text, SLACK_RULES)}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }
  return (
    <Card style={{ background: '#fff', color: '#1d1c1d', fontSize: 14 }}>
      <SenderLine name="WME Requests" badge="APP" />
      <div style={{ whiteSpace: 'pre-wrap', marginBottom: 4 }}>{renderRich(payload.text, SLACK_RULES)}</div>
      <div style={{ borderLeft: `4px solid ${attachment.color}`, paddingLeft: 12, maxWidth: 520 }}>
        {attachment.blocks.map(block)}
      </div>
    </Card>
  )
}
