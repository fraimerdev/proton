import type { ModuleSummary } from '@proton/core';
import { MODULE_BY_ID, type ModuleMeta, RECORD_LINKS, type RecordLink } from './catalogue.ts';

export interface ModuleHit {
  meta: ModuleMeta;
  /** Why this matched, when it was not the module's own name — a field label, or an alias. */
  hint?: string | undefined;
  score: number;
}

export interface RecordHit {
  link: RecordLink;
  score: number;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Ranks a whole-word prefix above a mid-word one: typing "role" should offer Role Menus and Join
 * Roles before it offers Moderation, which only matches inside "roles" in a field label.
 */
function score(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  if (index < 0) return 0;

  if (index === 0) return haystack.length === needle.length ? 100 : 80;
  if (haystack[index - 1] === ' ') return 60;
  return 20;
}

export function searchModules(
  query: string,
  summaries: readonly ModuleSummary[],
): { modules: ModuleHit[]; records: RecordHit[] } {
  const needle = normalise(query);
  if (needle === '') return { modules: [], records: [] };

  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const modules: ModuleHit[] = [];

  for (const meta of MODULE_BY_ID.values()) {
    let best = score(normalise(meta.label), needle);
    let hint: string | undefined;

    for (const alias of meta.aliases) {
      const aliasScore = score(normalise(alias), needle) - 5;
      if (aliasScore > best) {
        best = aliasScore;
        hint = alias;
      }
    }

    if (meta.areas) {
      for (const area of meta.areas) {
        const areaScore = score(normalise(area.label), needle) - 15;
        if (areaScore > best) {
          best = areaScore;
          hint = area.label;
        }
      }
    }

    // Every configurable field of every installed module rides the index for exactly this: an
    // admin who knows the setting's name but not which module owns it.
    for (const field of byId.get(meta.id)?.fields ?? []) {
      const fieldScore = score(normalise(field.label), needle) - 25;
      if (fieldScore > best) {
        best = fieldScore;
        hint = field.label;
      }
    }

    if (best > 0) modules.push({ meta, hint, score: best });
  }

  const records: RecordHit[] = [];
  for (const link of RECORD_LINKS) {
    let best = score(normalise(link.label), needle);
    for (const alias of link.aliases) best = Math.max(best, score(normalise(alias), needle) - 5);
    if (best > 0) records.push({ link, score: best });
  }

  modules.sort((a, b) => b.score - a.score || a.meta.label.localeCompare(b.meta.label));
  records.sort((a, b) => b.score - a.score);

  return { modules, records };
}
