import { EMBED_DESCRIPTION_MAX } from './embed.ts';

export const STATUS_SUCCESS_EMOJI = '<:checkmark:1543940009923448904>';
export const STATUS_ERROR_EMOJI = '<:xmark:1543940060506751106>';

export const STATUS_SUCCESS_COLOUR = 0x57f287;
export const STATUS_ERROR_COLOUR = 0xed4245;

export type StatusKind = 'success' | 'error';

export type StatusEmbed = { description: string; color: number };

export interface StatusBody {
  // Empty rather than absent: an edit or an update leaves untouched whatever fields it omits, so
  // a status embed replacing an older text reply would otherwise hang beneath the stale sentence.
  content: string;
  embeds: StatusEmbed[];
}

export function statusEmbed(kind: StatusKind, text: string): StatusEmbed {
  const emoji = kind === 'success' ? STATUS_SUCCESS_EMOJI : STATUS_ERROR_EMOJI;

  return {
    description: `${emoji} ${text.trim()}`.slice(0, EMBED_DESCRIPTION_MAX),
    color: kind === 'success' ? STATUS_SUCCESS_COLOUR : STATUS_ERROR_COLOUR,
  };
}

export function successEmbed(text: string): StatusEmbed {
  return statusEmbed('success', text);
}

export function errorEmbed(text: string): StatusEmbed {
  return statusEmbed('error', text);
}

export function statusBody(kind: StatusKind, text: string): StatusBody {
  return { content: '', embeds: [statusEmbed(kind, text)] };
}

export function successStatus(text: string): StatusBody {
  return statusBody('success', text);
}

export function errorStatus(text: string): StatusBody {
  return statusBody('error', text);
}

export function isStatusBody(value: unknown): value is StatusBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'embeds' in value &&
    Array.isArray((value as StatusBody).embeds)
  );
}
