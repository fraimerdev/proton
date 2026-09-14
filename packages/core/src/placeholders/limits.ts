export const PLACEHOLDER_LIMITS = {
  templateLength: 6000,
  placeholders: 100,
  modifiers: 4,
  arguments: 4,
  argumentLength: 200,
  keyLength: 200,
  listItems: 50,
  listLength: 1000,
  outputLength: 6000,
  diagnostics: 100,
} as const;

export const CHANNEL_NAME_MAX = 100;

export const URL_MAX = 2048;

export const BRACE_ESCAPE_HELP = 'Write {{ for a literal { and }} for a literal }.';

export const TEMPLATE_FIELDS = ['discord_text', 'plain_text', 'channel_name', 'url'] as const;

export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

export const FIELD_LABELS: Record<TemplateField, string> = {
  discord_text: 'Discord message text',
  plain_text: 'plain text',
  channel_name: 'a channel name',
  url: 'a link',
};

export const CHANNEL_KINDS = ['text', 'voice'] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const SENSITIVITIES = ['public', 'member_private', 'staff_only'] as const;

export type Sensitivity = (typeof SENSITIVITIES)[number];

export const SENSITIVITY_LABELS: Record<Sensitivity, string> = {
  public: 'anyone',
  member_private: 'the member it is about',
  staff_only: 'staff',
};

export function sensitivityRank(sensitivity: Sensitivity): number {
  return SENSITIVITIES.indexOf(sensitivity);
}
