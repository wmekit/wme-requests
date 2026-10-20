import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import apiFetch from './api-client'
import { subscribeToPush } from './push-client'
import type {
  AdminUser,
  BlockedSubmitter,
  Channel,
  Country,
  Credential,
  CredentialType,
  DiscordGuild,
  DiscordGuildChannel,
  DiscordGuildRole,
  Me,
  PushSubscription,
  Region,
  RequestsResponse,
  Status,
  UserReportResponse,
} from './types'

export function useCountries() {
  return useQuery({
    queryKey: ['countries'],
    queryFn: () => apiFetch<Country[]>('/countries'),
  })
}

export function useRegions(countryId: string | null) {
  return useQuery({
    queryKey: ['regions', countryId],
    queryFn: () => apiFetch<Region[]>(`/countries/${countryId}/regions`),
    enabled: !!countryId,
  })
}

export function useCreateRegion() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { countryId: string; name: string; code: string }) =>
      apiFetch(`/countries/${vars.countryId}/regions`, {
        method: 'POST',
        body: JSON.stringify({ name: vars.name, code: vars.code }),
      }),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ['regions', vars.countryId] }),
  })
}

export function useDeleteRegion() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { id: number; countryId: string }) => apiFetch(`/regions/${vars.id}`, { method: 'DELETE' }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['regions', vars.countryId] })
      qc.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export function useUserReport() {
  return useQuery({
    queryKey: ['reports', 'by-user'],
    queryFn: () => apiFetch<UserReportResponse>('/reports/by-user'),
  })
}

export interface RequestsFilter {
  countryId: string | null
  regionId: string | null
  type: string | null
  status: string | null
  limit: number
  offset: number
}

export function useRequests(filter: RequestsFilter) {
  const search = new URLSearchParams({
    limit: String(filter.limit),
    offset: String(filter.offset),
  })
  if (filter.countryId) search.set('country_id', filter.countryId)
  if (filter.regionId) search.set('region_id', filter.regionId)
  if (filter.type) search.set('type', filter.type)
  if (filter.status) search.set('status', filter.status)

  return useQuery({
    queryKey: ['requests', filter],
    queryFn: () => apiFetch<RequestsResponse>(`/requests?${search}`),
  })
}

export function useRequestStats() {
  return useQuery({
    queryKey: ['requests', 'stats'],
    queryFn: async () => {
      const [all, pending, inProgress, completed] = await Promise.all([
        apiFetch<RequestsResponse>('/requests?limit=1'),
        apiFetch<RequestsResponse>('/requests?status=pending&limit=1'),
        apiFetch<RequestsResponse>('/requests?status=in_progress&limit=1'),
        apiFetch<RequestsResponse>('/requests?status=completed&limit=1'),
      ])
      return {
        total: all.total,
        pending: pending.total,
        inProgress: inProgress.total,
        completed: completed.total,
      }
    },
  })
}

export function useUpdateRequestStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { id: number; status: Status }) =>
      apiFetch(`/requests/${vars.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: vars.status }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['requests'] }),
  })
}

export function useDeleteRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiFetch(`/requests/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['requests'] }),
  })
}

export function useDeleteRequests() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map((id) => apiFetch(`/requests/${id}`, { method: 'DELETE' }))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['requests'] }),
  })
}

export function useUpdateRequestsStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { ids: number[]; status: Status }) =>
      Promise.all(
        vars.ids.map((id) =>
          apiFetch(`/requests/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ status: vars.status }),
          }),
        ),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['requests'] }),
  })
}

export function useChannels(countryId: string | null) {
  return useQuery({
    queryKey: ['channels', countryId],
    queryFn: () => apiFetch<Channel[]>(`/countries/${countryId}/channels`),
    enabled: !!countryId,
  })
}

export function useCreateCountry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { name: string; code: string }) =>
      apiFetch('/countries', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['countries'] }),
  })
}

export function useUpdateCountry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { id: number; name: string; code: string }) =>
      apiFetch(`/countries/${vars.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: vars.name, code: vars.code }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['countries'] }),
  })
}

export function useDeleteCountry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiFetch(`/countries/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['countries'] })
      qc.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export interface ChannelFormValues {
  label: string
  platform: Channel['platform']
  event_type: Channel['event_type']
  // Optional — scopes the channel to one region within the country. null means country-wide.
  region_id: number | null
  webhook_url: string | null
  bot_token: string | null
  chat_id: string | null
  custom_prefix: string | null
  email_to: string | null
  discord_forum: boolean
  spreadsheet_id: string | null
  sheet_name: string | null
  // References a row in `credentials` — see useCredentials below.
  google_credential_id: number | null
  email_credential_id: number | null
  // discord_bot only — a server from useDiscordGuilds and a channel from useDiscordGuildChannels.
  discord_guild_id: string | null
  discord_channel_id: string | null
  discord_threaded: boolean
  discord_role_ids: string[]
}

export function useCreateChannel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { countryId: string } & ChannelFormValues) =>
      apiFetch(`/countries/${vars.countryId}/channels`, {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ['channels', vars.countryId] }),
  })
}

export function useUpdateChannel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { id: number; countryId: string } & ChannelFormValues) =>
      apiFetch(`/channels/${vars.id}`, {
        method: 'PUT',
        body: JSON.stringify(vars),
      }),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ['channels', vars.countryId] }),
  })
}

export function useDeleteChannel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { id: number; countryId: string }) => apiFetch(`/channels/${vars.id}`, { method: 'DELETE' }),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ['channels', vars.countryId] }),
  })
}

export function useTestChannel() {
  return useMutation({
    mutationFn: (id: number) => apiFetch(`/channels/${id}/test`, { method: 'POST' }),
  })
}

// Discord servers this country has added the bot to. Refetched whenever the window regains focus,
// so a server added in the "Add bot" tab shows up as soon as the user switches back.
export function useDiscordGuilds(countryId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['discord-guilds', countryId],
    queryFn: () => apiFetch<DiscordGuild[]>(`/countries/${countryId}/discord-guilds`),
    enabled: !!countryId && enabled,
    refetchOnWindowFocus: 'always',
  })
}

export function useDiscordGuildChannels(countryId: string | null, guildId: string | null) {
  return useQuery({
    queryKey: ['discord-guild-channels', countryId, guildId],
    queryFn: () => apiFetch<DiscordGuildChannel[]>(`/countries/${countryId}/discord-guilds/${guildId}/channels`),
    enabled: !!countryId && !!guildId,
    retry: false,
  })
}

export function useDiscordGuildRoles(countryId: string | null, guildId: string | null) {
  return useQuery({
    queryKey: ['discord-guild-roles', countryId, guildId],
    queryFn: () => apiFetch<DiscordGuildRole[]>(`/countries/${countryId}/discord-guilds/${guildId}/roles`),
    enabled: !!countryId && !!guildId,
    retry: false,
  })
}

export function useCredentials(type?: CredentialType) {
  const search = type ? `?type=${type}` : ''
  return useQuery({
    queryKey: ['credentials', type ?? 'all'],
    queryFn: () => apiFetch<Credential[]>(`/credentials${search}`),
  })
}

export interface CredentialFormValues {
  type: CredentialType
  label: string
  // Raw fields for `type` — see validatePayload in src/lib/credentials.ts. Write-only,
  // never sent back down by the API after saving.
  payload: Record<string, unknown>
}

export function useCreateCredential() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: CredentialFormValues) =>
      apiFetch<Credential>('/credentials', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  })
}

export function useUpdateCredential() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { id: number; label: string; payload?: Record<string, unknown> }) =>
      apiFetch<Credential>(`/credentials/${vars.id}`, {
        method: 'PUT',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  })
}

export function useDeleteCredential() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiFetch(`/credentials/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  })
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<Me>('/me'),
  })
}

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => apiFetch<AdminUser[]>('/users'),
  })
}

export interface UserAccessValues {
  isGlobal: boolean
  countryIds: number[]
}

export function useInviteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { name: string; email: string } & UserAccessValues) =>
      apiFetch('/users/invite', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })
}

export function useResetUserPassword() {
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/users/${id}/reset-password`, { method: 'POST' }),
  })
}

export function useRemoveUserAccess() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/users/${id}/access`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })
}

export function useUpdateUserAccess() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { id: string } & UserAccessValues) =>
      apiFetch(`/users/${vars.id}/access`, {
        method: 'PUT',
        body: JSON.stringify({
          isGlobal: vars.isGlobal,
          countryIds: vars.countryIds,
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })
}

// Only global users can list blocks; pass enabled=false for anyone else to skip the 403.
export function useBlockedSubmitters(enabled = true) {
  return useQuery({
    queryKey: ['blocked-submitters'],
    queryFn: () => apiFetch<BlockedSubmitter[]>('/blocked-submitters'),
    enabled,
  })
}

export function useBlockSubmitter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { username: string; reason: string | null }) =>
      apiFetch<BlockedSubmitter>('/blocked-submitters', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blocked-submitters'] }),
  })
}

export function useUnblockSubmitter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiFetch(`/blocked-submitters/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blocked-submitters'] }),
  })
}

export function useMySubscriptions() {
  return useQuery({
    queryKey: ['push-subscriptions'],
    queryFn: () => apiFetch<PushSubscription[]>('/push/subscriptions'),
  })
}

export function useSubscribePush() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { countryId: string; regionId: string | null; eventType: string }) => subscribeToPush(vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['push-subscriptions'] }),
  })
}

export function useUnsubscribePush() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiFetch(`/push/subscriptions/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['push-subscriptions'] }),
  })
}

export function useFeedToken() {
  return useQuery({
    queryKey: ['feed-token'],
    queryFn: () => apiFetch<{ token: string }>('/feed-token'),
  })
}

export function useRotateFeedToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch<{ token: string }>('/feed-token', { method: 'POST' }),
    onSuccess: (data) => qc.setQueryData(['feed-token'], data),
  })
}
