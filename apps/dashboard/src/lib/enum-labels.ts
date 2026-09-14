export function humaniseOption(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Verification keeps its own labels on purpose: its `none` is "let them try again", a retry rather
// than a decision not to act, so adopting this table there would change what the option means.
export const ACTION_LABELS = {
  none: 'Log only',
  warn: 'Warn',
  timeout: 'Timeout',
  kick: 'Kick',
  softban: 'Softban — remove and delete messages',
  ban: 'Ban',
  quarantine: 'Add quarantine role',
  verify: 'Add verification role',
};
