export type Rng = () => number;

export const SEED_HEX_LENGTH = 32;

const SEED_PATTERN = /^[0-9a-f]{32}$/;

// xoshiro128** — four 32-bit words of state, uniform in [0, 1), and identical across every
// engine that runs this file. Math.random cannot be seeded, so a draw run with it can never be
// reproduced from its audit row.
export function xoshiro128ss(seed: Uint32Array): Rng {
  if (seed.length !== 4) {
    throw new Error(`a xoshiro128** seed is four 32-bit words, not ${seed.length}`);
  }

  let [a, b, c, d] = [seed[0] ?? 0, seed[1] ?? 0, seed[2] ?? 0, seed[3] ?? 0];

  // An all-zero state is a fixed point: it would emit zero forever, and every winner would be
  // whichever entrant the sampler happened to see first.
  if ((a | b | c | d) === 0) a = 0x9e3779b9;

  return () => {
    const t = Math.imul(b, 5);
    const r = Math.imul((t << 7) | (t >>> 25), 9);

    const shifted = b << 9;

    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= shifted;
    d = (d << 11) | (d >>> 21);

    return (r >>> 0) / 4_294_967_296;
  };
}

export function seedFromHex(hex: string): Uint32Array {
  const normalised = hex.trim().toLowerCase();
  if (!SEED_PATTERN.test(normalised)) {
    throw new Error(
      `'${hex}' is not a draw seed: a seed is ${SEED_HEX_LENGTH} hexadecimal characters.`,
    );
  }

  const seed = new Uint32Array(4);
  for (let word = 0; word < 4; word += 1) {
    seed[word] = Number.parseInt(normalised.slice(word * 8, word * 8 + 8), 16) >>> 0;
  }

  return seed;
}

export function seedToHex(seed: Uint32Array): string {
  let hex = '';
  for (let word = 0; word < 4; word += 1) {
    hex += (seed[word] ?? 0).toString(16).padStart(8, '0');
  }
  return hex;
}

export function newSeed(random: () => Uint32Array = cryptoWords): string {
  return seedToHex(random());
}

function cryptoWords(): Uint32Array {
  return crypto.getRandomValues(new Uint32Array(4));
}

export function rngFromSeed(hex: string): Rng {
  return xoshiro128ss(seedFromHex(hex));
}
