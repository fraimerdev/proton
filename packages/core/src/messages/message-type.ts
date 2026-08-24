// 0 is an ordinary message, 19 a reply. Everything else in Discord's enum is a system notice — a
// join announcement, a boost, a pin — that no member wrote and none should be punished for.
export const HUMAN_MESSAGE_TYPES: ReadonlySet<number> = new Set([0, 19]);

export function isHumanMessage(type: number): boolean {
  return HUMAN_MESSAGE_TYPES.has(type);
}
