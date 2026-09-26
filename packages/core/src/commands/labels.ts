import type { ModuleContext } from '../modules/manifest.ts';

export type CommandLabeler = (key: string, path?: string) => string;

const MENU_PREFIXES = ['user:', 'message:'] as const;

function menuName(key: string): string | null {
  const prefix = MENU_PREFIXES.find((candidate) => key.startsWith(candidate));
  return prefix === undefined ? null : key.slice(prefix.length);
}

export function formatCommandLabel(key: string, path?: string, name?: string): string {
  const menu = menuName(key);
  if (menu !== null) return `Apps → ${name ?? menu}`;

  const words = (path ?? '')
    .split('.')
    .filter((part) => part !== '')
    .join(' ');
  return words === '' ? `/${name ?? key}` : `/${name ?? key} ${words}`;
}

export function labelOf(
  ctx: Pick<ModuleContext, 'commandLabel'>,
  key: string,
  path?: string,
): string {
  return ctx.commandLabel?.(key, path) ?? formatCommandLabel(key, path);
}
