const READS_AS_DISCORD = ['discord', 'clyde', 'wumpus', 'nitro'];

const READS_AS_STAFF = ['admin', 'administrator', 'mod', 'moderator', 'staff', 'system', 'support'];

// NFKC first: fullwidth and mathematical letters fold to plain ASCII under it, so a name spelled
// in maths-bold is caught by the same list as its plain spelling, without the list enumerating a
// single homoglyph. \p{Cf} then strips the zero-width joiners and marks used to break the words up.
export function normaliseName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

export function impersonationReason(nickname: string): string | null {
  const flat = normaliseName(nickname);

  const brand = READS_AS_DISCORD.find((word) => flat.includes(word));
  if (brand) {
    return `a nickname reading as "${brand}" claims to be Discord itself, which Discord's developer policy does not allow a bot to do`;
  }

  if (READS_AS_STAFF.includes(flat)) {
    return `"${nickname}" reads as a member of your staff rather than as a bot, so a member could be misled by it`;
  }

  return null;
}
