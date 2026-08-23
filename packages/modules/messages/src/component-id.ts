import { type CustomIdFor, encodeCustomId, parseCustomId } from '@proton/core';
import { MODULE_ID, normaliseTemplateName } from './config.ts';

export { encodedLength } from './config.ts';

export interface ComponentRef {
  messageName: string;
  key: string;
}

export function customIdFor(messageName: string): CustomIdFor {
  return (key) => {
    const encoded = encodeCustomId(MODULE_ID, normaliseTemplateName(messageName), key);

    // Refused at save time by templatesSchema, so reaching this means the config was written
    // around the dashboard; a truncated id would route a press to the wrong component.
    if (!encoded.ok) throw new Error(encoded.humanReason);

    return encoded.customId;
  };
}

// The id this module wrote while it was called `embeds`. Every button it has ever posted carries
// that prefix and is still sitting in a channel somewhere — there is no migration that can reach
// them, so this stays forever. New ids are written under MODULE_ID.
export const LEGACY_MODULE_ID = 'embeds';

export function readComponentRef(customId: unknown): ComponentRef | null {
  const parsed = parseCustomId(customId);
  const key = parsed?.args.length === 1 ? parsed.args[0] : undefined;
  if (!parsed || !key) return null;
  if (parsed.moduleId !== MODULE_ID && parsed.moduleId !== LEGACY_MODULE_ID) return null;

  return { messageName: parsed.action, key };
}
