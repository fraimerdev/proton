import { type CustomIdFor, encodeCustomId } from '@proton/core';
import { MODULE_ID } from './perform.ts';

export const LEVEL_UP_ACTION = 'level-up';

export const levelUpCustomId: CustomIdFor = (key) => {
  const encoded = encodeCustomId(MODULE_ID, LEVEL_UP_ACTION, key);

  // Component keys are capped well below the limit by componentKeySchema, so reaching this means
  // the config was written around the dashboard; a truncated id would collide with another key.
  if (!encoded.ok) throw new Error(encoded.humanReason);

  return encoded.customId;
};
