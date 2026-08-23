import { MAX_CUSTOM_ID_LENGTH } from '../actions/payloads.ts';

const CUSTOM_ID_NAMESPACE = 'proton';
const CUSTOM_ID_ESCAPE = '\\';

export const CUSTOM_ID_SEPARATOR = ':';

export interface ProtonCustomId {
  moduleId: string;
  action: string;
  args: string[];
}

export type EncodeCustomIdResult =
  | { ok: true; customId: string }
  | { ok: false; length: number; humanReason: string };

function escapeSegment(segment: string): string {
  let escaped = '';
  for (const character of segment) {
    if (character === CUSTOM_ID_ESCAPE || character === CUSTOM_ID_SEPARATOR) {
      escaped += CUSTOM_ID_ESCAPE;
    }
    escaped += character;
  }
  return escaped;
}

function splitSegments(raw: string): string[] | null {
  const segments: string[] = [];
  let current = '';
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      if (character !== CUSTOM_ID_ESCAPE && character !== CUSTOM_ID_SEPARATOR) return null;
      current += character;
      escaping = false;
      continue;
    }

    if (character === CUSTOM_ID_ESCAPE) {
      escaping = true;
      continue;
    }

    if (character === CUSTOM_ID_SEPARATOR) {
      segments.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  if (escaping) return null;

  segments.push(current);
  return segments;
}

export function encodeCustomId(
  moduleId: string,
  action: string,
  ...args: string[]
): EncodeCustomIdResult {
  const customId = [CUSTOM_ID_NAMESPACE, moduleId, action, ...args]
    .map(escapeSegment)
    .join(CUSTOM_ID_SEPARATOR);

  if (customId.length > MAX_CUSTOM_ID_LENGTH) {
    return {
      ok: false,
      length: customId.length,
      humanReason:
        `a custom_id for '${moduleId}' action '${action}' needs ${customId.length} characters and ` +
        `Discord allows ${MAX_CUSTOM_ID_LENGTH}. Shorten the ids it carries.`,
    };
  }

  return { ok: true, customId };
}

export function parseCustomId(raw: unknown): ProtonCustomId | null {
  // Discord caps custom_id at 100, so anything longer never came from us — parsing it anyway
  // would route a foreign or truncated id into a module's handler.
  if (typeof raw !== 'string' || raw.length > MAX_CUSTOM_ID_LENGTH) return null;

  const segments = splitSegments(raw);
  if (!segments || segments.length < 3) return null;

  const [namespace, moduleId, action, ...args] = segments;
  if (namespace !== CUSTOM_ID_NAMESPACE) return null;
  if (!moduleId || !action) return null;

  return { moduleId, action, args };
}
