// A module that registers optionLabels still wins; this is only what a schema that registered none
// falls back to. Without it the select beside "Severity" offered `off`, `low`, `medium`, `high` and
// the preset chips read `sexualContent`, which is the identifier, not the setting.
export function humaniseOption(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function optionLabel(value: string, labels?: Record<string, string> | undefined): string {
  return labels?.[value] ?? humaniseOption(value);
}

export const ACTION_CHOICES = [
  'none',
  'warn',
  'timeout',
  'kick',
  'softban',
  'ban',
  'quarantine',
  'verify',
] as const;

export type ActionChoice = (typeof ACTION_CHOICES)[number];

// Verification keeps its own labels on purpose: its `none` is "let them try again", a retry rather
// than a decision not to act, so adopting this table there would change what the option means.
export const ACTION_LABELS: Record<ActionChoice, string> = {
  none: 'Do nothing but log it',
  warn: 'Warn them',
  timeout: 'Time them out',
  kick: 'Kick them',
  softban: 'Remove them and delete what they posted',
  ban: 'Ban them',
  quarantine: 'Give them the quarantine role',
  verify: 'Make them verify',
};
