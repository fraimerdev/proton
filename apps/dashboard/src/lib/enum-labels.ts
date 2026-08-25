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
