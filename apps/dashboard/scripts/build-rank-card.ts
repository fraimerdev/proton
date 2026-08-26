import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCard } from '@proton/cards';

// The landing page shows a rank card, and a rank card is a PNG the bot renders — not markup a
// page can recreate. So the page ships one drawn by the shipping renderer from a fixture rather
// than a mockup somebody drew to look like it.
export const GENERATED_PATH = join(import.meta.dir, '..', 'public', 'art', 'rank-card.png');

export async function generate(): Promise<Uint8Array> {
  return renderCard({
    kind: 'rank',
    preset: 'midnight',
    displayName: 'Rin',
    level: 42,
    rank: 3,
    totalXp: 221_487,
    xpIntoLevel: 3_180,
    xpForNextLevel: 4_600,
  });
}

if (import.meta.main) {
  const png = await generate();
  writeFileSync(GENERATED_PATH, png);

  console.log(`wrote ${png.byteLength} bytes to ${GENERATED_PATH}`);
}
