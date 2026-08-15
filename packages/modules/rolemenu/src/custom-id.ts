export const CUSTOM_ID_SEPARATOR = ':';

export const CUSTOM_ID_PREFIX = `proton${CUSTOM_ID_SEPARATOR}rolemenu${CUSTOM_ID_SEPARATOR}`;

export const SELECT_BINDING_KEY = '*';

export interface RolemenuCustomId {
  menuId: string;
  bindingKey: string;
}

export function encodeCustomId(menuId: string, bindingKey: string): string {
  return `${CUSTOM_ID_PREFIX}${menuId}${CUSTOM_ID_SEPARATOR}${bindingKey}`;
}

export function hasRolemenuPrefix(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.startsWith(CUSTOM_ID_PREFIX);
}

export function parseCustomId(raw: unknown): RolemenuCustomId | null {
  if (!hasRolemenuPrefix(raw)) return null;

  const segments = raw.slice(CUSTOM_ID_PREFIX.length).split(CUSTOM_ID_SEPARATOR);
  if (segments.length !== 2) return null;

  const [menuId, bindingKey] = segments;
  if (!menuId || !bindingKey) return null;

  return { menuId, bindingKey };
}
