export type RNG = () => number;

export const mulberry32 = (seed: number): RNG => {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const shuffle = <T>(arr: readonly T[], rng: RNG = Math.random): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Derive a game's card-shuffle seed from its map seed. Kept distinct from the
// map RNG salt (state.ts uses `seed ^ 0x9e3779b9`) so card order and map
// layout don't visibly correlate.
export const deriveCardRngSeed = (seed: number): number => (seed ^ 0xc0ffee) >>> 0;

// Deterministic Fisher-Yates: shuffle `arr` from an integer `seed`, returning
// the result plus the advanced seed to persist on game state. This lets card
// order be reproducible across runs and save/load instead of depending on the
// non-deterministic `Math.random` default. Callers thread the returned `seed`
// back so each successive shuffle draws from a fresh point in the stream.
export const seededShuffle = <T>(arr: readonly T[], seed: number): { result: T[]; seed: number } => {
  const rng = mulberry32(seed);
  const result = shuffle(arr, rng);
  const next = Math.floor(rng() * 0x1_0000_0000) >>> 0;
  return { result, seed: next };
};
