import type { TicketPanel, TicketType } from './config.ts';
import { buildPanelComponents } from './interface.ts';

export { OPEN_ACTION, OPEN_TYPE_ACTION, SELECT_TYPE_ACTION } from './interface.ts';

export type PanelMessage =
  | { ok: true; components: Record<string, unknown>[] }
  | { ok: false; humanReason: string };

export function buildPanelMessage(panel: TicketPanel, types: readonly TicketType[]): PanelMessage {
  const built = buildPanelComponents(panel, types);

  return built.ok
    ? { ok: true, components: built.value.components }
    : { ok: false, humanReason: built.humanReason };
}
