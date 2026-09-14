import type { ModuleSummary } from '@proton/core';
import { MODULE_BY_ID, type ModuleMeta, RECORD_LINKS, type RecordLink } from './catalogue.ts';

export interface ModuleHit {
  meta: ModuleMeta;
  hint?: string | undefined;
  area?: string | undefined;
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

// A whole-word prefix outranks a mid-word hit, so "role" offers Role Menus before Moderation.
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
    if (meta.switchOnly) continue;

    let best = score(normalise(meta.label), needle);
    let hint: string | undefined;
    let area: string | undefined;

    for (const alias of meta.aliases) {
      const aliasScore = score(normalise(alias), needle) - 5;
      if (aliasScore > best) {
        best = aliasScore;
        hint = alias;
        area = undefined;
      }
    }

    if (meta.areas) {
      for (const candidate of meta.areas) {
        const areaScore = score(normalise(candidate.label), needle) - 15;
        if (areaScore > best) {
          best = areaScore;
          hint = candidate.label;
          area = candidate.id;
        }
      }
    }

    // Field labels are indexed for an admin who knows a setting's name but not its module.
    for (const field of byId.get(meta.id)?.fields ?? []) {
      const fieldScore = score(normalise(field.label), needle) - 25;
      if (fieldScore > best) {
        best = fieldScore;
        hint = field.label;
        area = undefined;
      }
    }

    if (best > 0) modules.push({ meta, hint, area, score: best });
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
