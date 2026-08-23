import { encodeCustomId } from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import { MODULE_ID, type TicketPanel } from './config.ts';

export const OPEN_ACTION = 'open';

export type PanelMessage =
  | { ok: true; content: string; components: Record<string, unknown>[] }
  | { ok: false; humanReason: string };

export function buildPanelMessage(panel: TicketPanel): PanelMessage {
  const customId = encodeCustomId(MODULE_ID, OPEN_ACTION, panel.id);

  if (!customId.ok) {
    return {
      ok: false,
      humanReason: `The panel id '${panel.id}' is too long to fit in a Discord button: ${customId.humanReason}`,
    };
  }

  return {
    ok: true,
    content: panel.panelText,
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Primary,
            label: panel.buttonLabel,
            custom_id: customId.customId,
          },
        ],
      },
    ],
  };
}
