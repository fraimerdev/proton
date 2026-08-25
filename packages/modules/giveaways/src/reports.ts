import type { EntrantRow, GiveawayStats, GiveawayStore } from './store.ts';

export const ENTRANT_PAGE_SIZE = 20;
export const EXPORT_CHUNK_SIZE = 500;

/** Never unbounded: a giveaway with a million entrants must not be materialised to answer a page. */
export const EXPORT_ROW_MAX = 50_000;

export interface EntrantPage {
  rows: EntrantRow[];
  page: number;
  pages: number;
  total: number;
}

/**
 * Pages by walking the keyset iterator rather than by OFFSET. It costs one extra pass for a deep
 * page, but the walk is the same ordering the draw uses, so what a host is shown and what is drawn
 * cannot disagree.
 */
export async function entrantPage(
  store: GiveawayStore,
  giveawayId: string,
  page: number,
  size: number = ENTRANT_PAGE_SIZE,
): Promise<EntrantPage> {
  const total = await store.entrantCount(giveawayId);
  const pages = Math.max(1, Math.ceil(total / size));
  const wanted = Math.min(Math.max(1, page), pages);

  const skip = (wanted - 1) * size;
  const rows: EntrantRow[] = [];
  let seen = 0;

  for await (const chunk of store.entrants(giveawayId, size)) {
    for (const row of chunk) {
      if (seen >= skip && rows.length < size) rows.push(row);
      seen += 1;
    }

    if (rows.length >= size) break;
  }

  return { rows, page: wanted, pages, total };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export interface ExportResult {
  csv: string;
  rows: number;
  truncated: boolean;
}

/**
 * Streams the keyset walk into a CSV. Bounded by EXPORT_ROW_MAX and reported when it bites — a
 * silently truncated export reads as a complete one, which is worse than no export at all.
 */
export async function exportEntrants(
  store: GiveawayStore,
  giveawayId: string,
): Promise<ExportResult> {
  const lines = ['user_id,effective_entries,joined_via_snapshot'];
  let rows = 0;
  let truncated = false;

  for await (const chunk of store.entrants(giveawayId, EXPORT_CHUNK_SIZE)) {
    for (const row of chunk) {
      if (rows >= EXPORT_ROW_MAX) {
        truncated = true;
        break;
      }

      lines.push(
        [
          csvCell(row.userId),
          csvCell(row.totalEntries),
          csvCell(row.memberSnapshot === null ? 'no' : 'yes'),
        ].join(','),
      );
      rows += 1;
    }

    if (truncated) break;
  }

  return { csv: `${lines.join('\n')}\n`, rows, truncated };
}

export function renderStats(stats: GiveawayStats, guildName = 'this server'): string {
  const live =
    stats.byStatus.running +
    stats.byStatus.scheduled +
    stats.byStatus.paused +
    stats.byStatus.drawing;

  if (stats.totalGiveaways === 0) {
    return `No giveaways have been run in ${guildName} yet. Start one with \`/giveaway create\`.`;
  }

  const average =
    stats.byStatus.ended === 0 ? 0 : Math.round(stats.uniqueEntrants / stats.byStatus.ended);

  return [
    `**Giveaway statistics — ${guildName}**`,
    '',
    `**${stats.totalGiveaways}** giveaways · **${live}** live · ` +
      `**${stats.byStatus.ended}** finished · **${stats.byStatus.cancelled}** cancelled`,
    `**${stats.uniqueEntrants}** unique entrants holding **${stats.totalEntries}** entries`,
    `**${stats.totalWinners}** winners across **${stats.draws}** draws`,
    average === 0 ? '' : `Around **${average}** entrants per finished giveaway.`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}
