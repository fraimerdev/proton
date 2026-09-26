import { z } from 'zod';
import { filled } from './settings.ts';

export const COMMAND_KINDS = ['chat', 'user', 'message'] as const;

export const commandKindSchema = z.enum(COMMAND_KINDS);

export type CommandKind = z.infer<typeof commandKindSchema>;

export const commandNameEntrySchema = z.object({
  key: z.string(),
  kind: commandKindSchema,
  defaultName: z.string(),
  customName: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type CommandNameEntry = z.infer<typeof commandNameEntrySchema>;

export const resolvedCommandNamesSchema = z.object({
  names: z.record(z.string(), z.string()),
  ignored: z.record(z.string(), z.string()),
});

export type ResolvedCommandNames = z.infer<typeof resolvedCommandNamesSchema>;

function comparable(kind: CommandKind, name: string): string {
  return kind === 'chat' ? name : name.toLowerCase();
}

export function commandLabel(kind: CommandKind, name: string): string {
  return kind === 'chat' ? `/${name}` : `“${name}”`;
}

function savedAt(entry: CommandNameEntry): number {
  const at = entry.updatedAt === null ? Number.NaN : Date.parse(entry.updatedAt);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

function byKey(a: CommandNameEntry, b: CommandNameEntry): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function winnerOf(group: readonly CommandNameEntry[], custom: ReadonlySet<string>) {
  const defaults = group.filter((entry) => !custom.has(entry.key)).sort(byKey);
  if (defaults[0]) return defaults[0];

  return [...group].sort((a, b) => savedAt(a) - savedAt(b) || byKey(a, b))[0];
}

export function resolveCommandNames(entries: readonly CommandNameEntry[]): ResolvedCommandNames {
  const names: Record<string, string> = {};
  const ignored: Record<string, string> = {};
  const custom = new Set<string>();

  for (const entry of entries) {
    const wanted = filled(entry.customName) ? entry.customName : entry.defaultName;
    names[entry.key] = wanted;
    if (wanted !== entry.defaultName) custom.add(entry.key);
  }

  for (;;) {
    const holders = new Map<string, CommandNameEntry[]>();
    for (const entry of entries) {
      const slot = `${entry.kind}:${comparable(entry.kind, names[entry.key] ?? entry.defaultName)}`;
      holders.set(slot, [...(holders.get(slot) ?? []), entry]);
    }

    let reverted = false;

    for (const group of holders.values()) {
      if (group.length < 2) continue;

      const winner = winnerOf(group, custom);
      if (!winner) continue;

      const held = names[winner.key] ?? winner.defaultName;

      for (const loser of group) {
        if (loser === winner || !custom.has(loser.key)) continue;

        const back = commandLabel(loser.kind, loser.defaultName);
        ignored[loser.key] = custom.has(winner.key)
          ? `${commandLabel(winner.kind, winner.defaultName)} was renamed to ` +
            `${commandLabel(winner.kind, held)} first, so this command is back to ${back}.`
          : `Proton now has its own ${commandLabel(winner.kind, held)}, so this command is back ` +
            `to ${back}.`;

        names[loser.key] = loser.defaultName;
        custom.delete(loser.key);
        reverted = true;
      }
    }

    if (!reverted) return { names, ignored };
  }
}

export function nameClash(
  entries: readonly CommandNameEntry[],
  key: string,
  candidate: string | null,
): string | null {
  const edited = entries.find((entry) => entry.key === key);
  if (!edited || !filled(candidate) || candidate === edited.defaultName) return null;

  const { names } = resolveCommandNames(entries);
  const wanted = comparable(edited.kind, candidate);

  for (const other of entries) {
    if (other.key === key || other.kind !== edited.kind) continue;

    const held = names[other.key] ?? other.defaultName;
    if (comparable(other.kind, held) !== wanted) continue;

    const owner = commandLabel(other.kind, other.defaultName);
    return held === other.defaultName
      ? `Proton already has a ${owner} command. Pick another name.`
      : `${owner} is already called “${held}”. Rename ${owner} first.`;
  }

  return null;
}
