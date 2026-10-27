export interface TemplateVariable {
  key: string
  description: string
}

// Variables substituted into a channel's Custom Prefix template per-request.
// Keep in sync with the `vars` object built in notifications.ts.
export const CUSTOM_PREFIX_VARIABLES: readonly TemplateVariable[] = [
  {
    key: 'lock_level',
    description: "Request's lock level (set for downlock, uplock, and PUR requests; empty for imagery)",
  },
  { key: 'country_code', description: "Channel's country code, e.g. ZA" },
  { key: 'country_name', description: "Channel's country name, e.g. South Africa" },
  { key: 'region_code', description: "Channel's region code, e.g. CA (empty if country-wide)" },
  { key: 'region_name', description: "Channel's region name, e.g. California (empty if country-wide)" },
  { key: 'editor_rank', description: "Submitter's WME editor rank" },
  { key: 'type', description: 'downlock, uplock, imagery, accept_pur, or decline_pur' },
  { key: 'submitted_by', description: "Submitter's Waze username" },
]

// Discord (Bot) thread/forum post titles — the prefix variables plus the day the thread started.
export const THREAD_TITLE_VARIABLES: readonly TemplateVariable[] = [
  ...CUSTOM_PREFIX_VARIABLES,
  { key: 'date', description: 'Today\'s date (UTC), e.g. 2026-10-27' },
]
