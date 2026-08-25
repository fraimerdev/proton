export function documentTitle(...parts: readonly (string | undefined)[]): string {
  return [...parts.filter((part): part is string => Boolean(part)), 'Proton'].join(' · ');
}
