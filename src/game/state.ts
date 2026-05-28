import type {
  Card, City, FactionId, FactionPresetId, FactionState, GameConfig, GameState,
  Hex, HexKey, Seat, Unit, UnitType,
} from './types';
import {
  CARD_POOL, FACTION_PRESETS, RUNTIME_FACTION_IDS, TERRAIN, UNIT_TYPES,
  LIVING_UNIT_TYPES, UNDEAD_UNIT_TYPES,
} from './constants';
import { hexKey, neighbors } from './hex';
import { mulberry32, seededShuffle, deriveCardRngSeed } from './rng';
import { generateMap, finalizeMap, placeSpawns } from './mapgen';
import { applyStartOfSeatTurn } from './turn';

// Card uids are namespaced by factionId so two seats with the same card
// never collide on React `key` or cross-faction card references (e.g. a
// future "steal an enemy card" effect). Returns strings like "f1:rally#0".
// Shuffled deterministically from `seed`; returns the shuffled deck plus the
// advanced seed so initialState can thread one RNG stream across all seats.
export const makeStarterDeck = (factionId: FactionId, seed: number): { deck: Card[]; seed: number } => {
  const deck: Card[] = [];
  let i = 0;
  CARD_POOL.forEach((c) => {
    const copies = c.cost <= 1 ? 2 : 1;
    for (let n = 0; n < copies; n++) {
      deck.push({ ...c, uid: `${factionId}:${c.id}#${i++}` });
    }
  });
  const { result, seed: next } = seededShuffle(deck, seed);
  return { deck: result, seed: next };
};

const presetById = (id: FactionPresetId) => {
  const preset = FACTION_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown faction preset: ${id}`);
  return preset;
};

// Returns the list of active seats (kind !== 'empty'). Runtime faction ids
// remain unique; selected faction presets are read from config when present.
// Legacy configs with no factionPresetId fall back to old active-order mapping.
export const activeSeats = (config: GameConfig): Seat[] => {
  return config.seats
    .map((seat, idx) => ({ ...seat, idx }))
    .filter((seat) => seat.kind !== 'empty')
    .map((seat, runtimeIdx) => {
      const fallbackPresetId = FACTION_PRESETS[runtimeIdx]?.id ?? FACTION_PRESETS[0].id;
      return {
        idx: seat.idx,
        kind: seat.kind,
        name: seat.name,
        factionId: RUNTIME_FACTION_IDS[runtimeIdx] ?? RUNTIME_FACTION_IDS[0],
        factionPresetId: seat.factionPresetId ?? fallbackPresetId,
      };
    });
};

const unitPoolFor = (preset: typeof FACTION_PRESETS[number]): UnitType[] =>
  preset.unitPool === 'undead' ? UNDEAD_UNIT_TYPES : LIVING_UNIT_TYPES;

// Reveal a diamond area around (q,r) on a per-faction explored set.
export const revealArea = (explored: Set<HexKey>, q: number, r: number, radius = 2): void => {
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = -radius; dr <= radius; dr++) {
      const ds = -dq - dr;
      if (Math.abs(dq) + Math.abs(dr) + Math.abs(ds) <= 2 * radius) {
        explored.add(hexKey(q + dq, r + dr));
      }
    }
  }
};

export const initialState = (config: GameConfig): GameState => {
  const seed = config.seed ?? Math.floor(Math.random() * 1_000_000);
  const { tiles, cols, rows, resolvedType } = generateMap({ ...config, seed });

  const seats = activeSeats(config);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const spawns = placeSpawns(tiles, seats.length, cols, rows, rng);
  finalizeMap(tiles, spawns);

  let unitUid = 1;
  const mkUnit = (type: UnitType, q: number, r: number, factionId: FactionId): Unit => ({
    id: unitUid++, type, faction: factionId, q, r,
    hp: UNIT_TYPES[type].hp, maxHp: UNIT_TYPES[type].hp,
    moved: 0, acted: false, atkBuff: 0, movBuff: 0, kills: 0, level: 0,
  });

  // Advancing seed for all card shuffles this game, derived from the map seed
  // and persisted on state so card order is reproducible (see GameState.cardRng).
  let cardRng = deriveCardRngSeed(seed);

  const factions: Partial<Record<FactionId, FactionState>> = {};
  const cities: City[] = [];
  const units: Unit[] = [];
  seats.forEach((seat, i) => {
    const preset = presetById(seat.factionPresetId);
    const spawn = spawns[i];
    const explored = new Set<HexKey>();
    revealArea(explored, spawn.q, spawn.r, 2);
    const { deck, seed: nextRng } = makeStarterDeck(seat.factionId, cardRng);
    cardRng = nextRng;
    // Every faction — human or AI — opens with a 4-card hand. Cards are an
    // order-driven economy separate from gold/food, so AI seats participate
    // in it too (their start-of-turn draw is generalized in turn.ts).
    const hand = deck.splice(0, 4);

    factions[seat.factionId] = {
      id: seat.factionId,
      factionPresetId: seat.factionPresetId,
      kind: seat.kind,
      name: preset.cityName,
      displayName: seat.name || preset.name,
      color: preset.color,
      accent: preset.accent,
      glyph: preset.glyph,
      pattern: preset.pattern,
      unitPool: preset.unitPool,
      gold: 5,
      food: 5,
      deck,
      hand,
      discard: [],
      orders: 3,
      buildings: new Set(),
      explored,
      totalKills: 0,
      totalCardsPlayed: 0,
      ambushActive: false,
    };

    cities.push({
      id: i + 1,
      faction: seat.factionId,
      q: spawn.q,
      r: spawn.r,
      name: preset.cityName,
      hp: 20,
      maxHp: 20,
    });

    const pool = unitPoolFor(preset);
    const starterTypes: UnitType[] = seat.kind === 'human'
      ? [pool[0], pool[3 % pool.length]]
      : [pool[0], pool[1 % pool.length]];
    const nearby: Hex[] = [{ q: spawn.q, r: spawn.r }, ...neighbors(spawn.q, spawn.r)];
    let placed = 0;
    for (const slot of nearby) {
      if (placed >= starterTypes.length) break;
      const tile = tiles[hexKey(slot.q, slot.r)];
      if (!tile || !TERRAIN[tile.type].passable) continue;
      if (units.some((u) => u.q === slot.q && u.r === slot.r)) continue;
      units.push(mkUnit(starterTypes[placed], slot.q, slot.r, seat.factionId));
      placed++;
    }
  });

  // Start with the first non-empty seat active. At T=1 no one has played
  // yet, so there's no hidden state that would require pass-device gating;
  // the gate kicks in only on transitions into a human seat.
  const state: GameState = {
    turn: 1,
    activeSeatIdx: seats[0].idx,
    seed,
    cardRng,
    config: { ...config, seed, resolvedMapType: resolvedType },
    map: tiles,
    mapCols: cols,
    mapRows: rows,
    seats,
    cities,
    units,
    factions: factions as Record<FactionId, FactionState>,
    status: 'playing',
    winner: null,
    log: [{ turn: 1, faction: 'system', text: `The ${seats.length}-way war begins. Resolved map: ${resolvedType}.` }],
    targeting: null,
    selectedUnitId: null,
    undoBuffer: null,
    pendingPassSeatIdx: null,
  };

  // Seat 0 starts "live" — apply their start-of-turn housekeeping (orders,
  // draw cards, reveal around units/cities) so the UI doesn't need a
  // mount effect + `APPLY_START_OF_TURN_FOR_SEAT` action + ref-tracking
  // to remember whether it already ran. Subsequent seats are started by
  // the reducer when the turn rotates into them.
  applyStartOfSeatTurn(state, seats[0].factionId);
  return state;
};

export const activeSeat = (state: GameState): Seat | undefined =>
  state.seats.find((s) => s.idx === state.activeSeatIdx);

export const activeFaction = (state: GameState): FactionState | null => {
  const seat = activeSeat(state);
  return seat ? state.factions[seat.factionId] : null;
};

// Factions that still own at least one city.
export const aliveFactions = (state: GameState): FactionState[] =>
  Object.values(state.factions).filter((f): f is FactionState =>
    !!f && state.cities.some((c) => c.faction === f.id)
  );

// Last-faction-standing victory check.
export const checkVictory = (state: GameState): { status: GameState['status']; winner: FactionId | null } => {
  const alive = aliveFactions(state);
  if (alive.length <= 1) {
    return { status: 'ended', winner: alive[0]?.id ?? null };
  }
  return { status: 'playing', winner: null };
};
