// Single source of truth for every type the game passes around. Import
// from here instead of redefining shapes locally so the compiler can catch
// mismatches across modules.

// --- Hex grid ---

export type Hex = { q: number; r: number };
export type HexKey = string; // canonical "q,r"

// --- Terrain / tiles ---

export type TerrainType = 'grass' | 'forest' | 'hills' | 'mountain' | 'water' | 'coast';

export type TerrainInfo = {
  color: string;
  edge: string;
  name: string;
  passable: boolean;
  defense: number;
  yield: { gold?: number; food?: number };
};

export type Tile = { q: number; r: number; type: TerrainType };
export type TileMap = Record<HexKey, Tile>;

// --- Factions / seats ---

export type FactionId = 'f1' | 'f2' | 'f3' | 'f4';
export type FactionPresetId = 'aldermere' | 'grimhold' | 'sunspire' | 'moonwatch';
export type SeatKind = 'human' | 'ai' | 'empty';
export type UnitPoolKind = 'living' | 'undead';

export type FactionPreset = {
  id: FactionPresetId;
  name: string;
  cityName: string;
  color: string;
  accent: string;
  glyph: string;
  pattern: string;
  unitPool: UnitPoolKind;
  tagline: string;
  tooltip: string;
  strengths: string[];
  weaknesses: string[];
  playstyle: string;
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
};

export type SeatConfig = {
  kind: SeatKind;
  name: string;
  factionPresetId?: FactionPresetId;
};

// A seat in the running game (after dropping "empty" entries). `idx`
// preserves the original slot index so presets map 1:1 to seat numbers.
export type Seat = {
  idx: number;
  factionId: FactionId;
  factionPresetId: FactionPresetId;
  kind: SeatKind;
  name: string;
};

export type FactionState = {
  id: FactionId;
  factionPresetId: FactionPresetId;
  kind: SeatKind;
  name: string;
  displayName: string;
  color: string;
  accent: string;
  glyph: string;
  pattern: string;
  unitPool: UnitPoolKind;
  gold: number;
  food: number;
  deck: Card[];
  hand: Card[];
  discard: Card[];
  orders: number;
  buildings: Set<BuildingId>;
  explored: Set<HexKey>;
  // Running totals for the end-of-game stats screen. Reset never — these
  // track the entire match from T1 to victory.
  totalKills: number;
  totalCardsPlayed: number;
  // Set when Ambush is played this turn; applies a +3 bonus vs enemies
  // that haven't acted yet. Cleared at start of next rotation.
  ambushActive: boolean;
};

// --- Units / cities ---

export type UnitType =
  | 'knight' | 'mage' | 'barbarian' | 'rogue' | 'archer'
  | 'skeleton' | 'wraith' | 'lich';

export type UnitDef = {
  name: string;
  hp: number;
  atk: number;
  mov: number;
  range: number;
  cost: { gold: number; food: number };
  glyph: string;
  color: string;
};

export type Unit = {
  id: number;
  type: UnitType;
  faction: FactionId;
  q: number;
  r: number;
  hp: number;
  maxHp: number;
  moved: number;
  acted: boolean;
  atkBuff: number;
  movBuff: number;
  // XP / leveling. `kills` accumulates across turns; each 2 kills bumps
  // `level` by 1 (capped at 3), granting +1 HP and +1 atk per level on
  // level-up (also heals to full). Displayed as chevrons in the unit
  // badge.
  kills: number;
  level: number;
};

export type City = {
  id: number;
  faction: FactionId;
  q: number;
  r: number;
  name: string;
  hp: number;
  maxHp: number;
};

// --- Buildings / cards ---

export type BuildingId =
  | 'granary' | 'market' | 'walls' | 'barracks'
  | 'watchtower' | 'tavern' | 'war_council' | 'temple'
  | 'granary2' | 'market2' | 'walls2' | 'barracks2';

export type BuildingDef = {
  name: string;
  desc: string;
  cost: { gold: number; food: number };
  icon: string;
};

export type CardId =
  | 'march' | 'rally' | 'harvest' | 'heal'
  | 'scout' | 'hex' | 'muster' | 'feast'
  | 'ambush' | 'sabotage' | 'siege';

export type CardTarget = 'none' | 'ally_unit' | 'enemy_unit' | 'enemy_city' | 'tile';

export type CardTemplate = {
  id: CardId;
  name: string;
  desc: string;
  cost: number;
  target: CardTarget;
};

export type Card = CardTemplate & { uid: string };

// --- Map config ---

export type MapSizeId = 'small' | 'medium' | 'large' | 'huge';
export type MapTypeId = 'continents' | 'islands' | 'pangaea' | 'highlands' | 'random';

export type GameConfig = {
  mapSize: MapSizeId;
  mapType: MapTypeId;
  seats: SeatConfig[];
  seed?: number;
  // Set by initialState after resolving "random" to a concrete type.
  resolvedMapType?: MapTypeId;
};

// --- Game state ---

export type GameStatus = 'playing' | 'ended';
export type LogFaction = FactionId | 'system';
export type LogEntry = {
  turn: number;
  faction: LogFaction;
  text: string;
  // Optional hex coordinate. When present, the UI can render the entry
  // as a button that pans/centers the board cursor on that hex — lets
  // players jump from "Knight strikes for 5" back to the combat.
  hex?: { q: number; r: number };
};
export type TargetingState = { card: Card } | null;

// Combat target wrapper passed from the UI to gameActions.
export type UnitAttackTarget = { type: 'unit'; target: Unit };
export type CityAttackTarget = { type: 'city'; target: City };
export type AttackTarget = UnitAttackTarget | CityAttackTarget;

export type GameState = {
  turn: number;
  activeSeatIdx: number;
  seed: number;
  // Advancing integer seed for the card economy's shuffles (starter decks and
  // deck-from-discard reshuffles). Persisted so AI/human card order is
  // reproducible for a given map seed across runs and save/load, rather than
  // depending on Math.random. Derived from `seed` at game start.
  cardRng: number;
  config: GameConfig;
  map: TileMap;
  mapCols: number;
  mapRows: number;
  seats: Seat[];
  cities: City[];
  units: Unit[];
  factions: Record<FactionId, FactionState>;
  status: GameStatus;
  winner: FactionId | null;
  log: LogEntry[];
  targeting: TargetingState;
  // The currently-selected friendly unit id, or null if no selection. Drives
  // the move/attack overlays on the board. Lives on GameState (rather than
  // local UI state) so selection is part of the reducer contract and the
  // autosave captures it.
  selectedUnitId: number | null;
  // One-step undo buffer. Captured on MOVE_UNIT, cleared by any action
  // that commits the turn (attack, end turn, play card). Lets the user
  // back out of a mis-clicked move without losing the rest of their turn.
  // Null when no undo is available. Intentionally not deep: only the unit
  // snapshot + faction explored set, since those are the only fields a
  // move actually changes.
  undoBuffer: {
    unitId: number;
    q: number;
    r: number;
    moved: number;
    explored: HexKey[];
  } | null;
  // Seat that is about to play but is gated behind a pass-device screen
  // (set during endTurn when we rotate into a human seat and another human
  // currently "holds" the device). `null` means no gate is active.
  pendingPassSeatIdx: number | null;
};
