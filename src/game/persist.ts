import { FACTION_PRESETS, RUNTIME_FACTION_IDS } from './constants';
import { deriveCardRngSeed } from './rng';
import type { FactionId, FactionPresetId, FactionState, GameState } from './types';

// localStorage key for the single autosave slot. Single slot is intentional:
// the game is short enough that multiple saves add UI surface without a
// clear win. Migrating to keyed slots later is a one-field change.
const STORAGE_KEY = 'helmets-clash:save:v1';

// Sets don't survive JSON.stringify, so replace them with arrays on save
// and rehydrate on load. Everything else in GameState is already JSON-safe
// (primitives, plain objects, arrays).
type SerializableFactionState = Omit<FactionState, 'buildings' | 'explored'> & {
  buildings: string[];
  explored: string[];
};
type SerializableGameState = Omit<GameState, 'factions'> & {
  factions: Record<FactionId, SerializableFactionState>;
};

const VALID_PRESET_IDS = new Set<FactionPresetId>(FACTION_PRESETS.map((p) => p.id));
const DEFAULT_PRESET_ID: FactionPresetId = 'aldermere';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isGameStatus = (value: unknown): value is GameState['status'] =>
  value === 'playing' || value === 'ended';
const isSeatKind = (kind: unknown): kind is GameState['seats'][number]['kind'] =>
  kind === 'human' || kind === 'ai' || kind === 'empty';
const asPresetId = (v: unknown): FactionPresetId | null =>
  typeof v === 'string' && VALID_PRESET_IDS.has(v as FactionPresetId) ? (v as FactionPresetId) : null;
const normalizeSeatKind = (kind: unknown): GameState['seats'][number]['kind'] =>
  isSeatKind(kind) ? kind : 'human';
const normalizeName = (name: unknown): string => typeof name === 'string' ? name : '';

const toSerializable = (s: GameState): SerializableGameState => {
  const factions = {} as SerializableGameState['factions'];
  for (const [k, v] of Object.entries(s.factions) as Array<[FactionId, FactionState]>) {
    factions[k] = {
      ...v,
      buildings: Array.from(v.buildings),
      explored: Array.from(v.explored),
    };
  }
  return { ...s, factions };
};

const fromSerializable = (s: SerializableGameState): GameState => {
  const factions = {} as GameState['factions'];
  for (const [k, v] of Object.entries(s.factions) as Array<[FactionId, SerializableFactionState]>) {
    factions[k] = {
      ...v,
      buildings: new Set(v.buildings),
      explored: new Set(v.explored),
    } as FactionState;
  }
  return { ...s, factions } as GameState;
};

const migrateConfig = (
  rawConfig: Record<string, unknown>,
  fallbackSeats: Array<Record<string, unknown> & { factionPresetId: FactionPresetId }>,
): GameState['config'] | null => {
  const rawSeats = rawConfig.seats;
  if (rawSeats !== undefined) {
    if (!Array.isArray(rawSeats) || !rawSeats.every(isObject)) return null;
    return {
      ...(rawConfig as GameState['config']),
      seats: rawSeats.map((seat, idx) => ({
        ...seat,
        kind: normalizeSeatKind(seat.kind),
        name: normalizeName(seat.name),
        factionPresetId: asPresetId(seat.factionPresetId) ?? FACTION_PRESETS[idx]?.id ?? DEFAULT_PRESET_ID,
      })) as GameState['config']['seats'],
    };
  }
  return {
    ...(rawConfig as GameState['config']),
    seats: fallbackSeats.map((seat, idx) => ({
      kind: normalizeSeatKind(seat.kind),
      name: normalizeName(seat.name),
      factionPresetId: asPresetId(seat.factionPresetId) ?? FACTION_PRESETS[idx]?.id ?? DEFAULT_PRESET_ID,
    })),
  };
};

export const migrateLoadedGameState = (parsed: unknown): GameState | null => {
  if (!isObject(parsed)) return null;
  if (
    !Array.isArray(parsed.seats)
    || !parsed.seats.every(isObject)
    || !isObject(parsed.factions)
    || !isObject(parsed.map)
    || !isObject(parsed.config)
    || !Array.isArray(parsed.cities)
    || !parsed.cities.every(isObject)
    || !Array.isArray(parsed.units)
    || !parsed.units.every(isObject)
    || !Array.isArray(parsed.log)
    || !parsed.log.every(isObject)
    || !Number.isFinite(parsed.turn)
    || !Number.isFinite(parsed.seed)
    || !Number.isFinite(parsed.activeSeatIdx)
    || !Number.isFinite(parsed.mapCols)
    || !Number.isFinite(parsed.mapRows)
    || !isGameStatus(parsed.status)
  ) return null;

  const legacySeatFallbackByFaction = new Map<FactionId, FactionPresetId>();
  let activeRuntimeIdx = 0;
  for (const seat of parsed.seats) {
    if (seat.kind === 'empty') continue;
    const seatFactionId = typeof seat.factionId === 'string' ? seat.factionId as FactionId : null;
    if (!seatFactionId) {
      activeRuntimeIdx++;
      continue;
    }
    const existing = asPresetId(seat.factionPresetId);
    const fallback = FACTION_PRESETS[activeRuntimeIdx]?.id ?? DEFAULT_PRESET_ID;
    legacySeatFallbackByFaction.set(seatFactionId, existing ?? fallback);
    activeRuntimeIdx++;
  }

  for (const [runtimeIdx, fid] of RUNTIME_FACTION_IDS.entries()) {
    if (!legacySeatFallbackByFaction.has(fid)) {
      legacySeatFallbackByFaction.set(fid, FACTION_PRESETS[runtimeIdx]?.id ?? DEFAULT_PRESET_ID);
    }
  }

  const migratedFactions: Partial<Record<FactionId, SerializableFactionState>> = {};
  for (const [factionId, rawFaction] of Object.entries(parsed.factions)) {
    if (!isObject(rawFaction)) return null;
    if (!RUNTIME_FACTION_IDS.includes(factionId as FactionId)) continue;
    const id = factionId as FactionId;
    const factionPresetId = asPresetId(rawFaction.factionPresetId)
      ?? legacySeatFallbackByFaction.get(id)
      ?? DEFAULT_PRESET_ID;

    migratedFactions[id] = {
      ...(rawFaction as SerializableFactionState),
      factionPresetId,
      buildings: Array.isArray(rawFaction.buildings) ? rawFaction.buildings.filter((b): b is string => typeof b === 'string') : [],
      explored: Array.isArray(rawFaction.explored) ? rawFaction.explored.filter((e): e is string => typeof e === 'string') : [],
    };
  }

  const activeSeatSources = parsed.seats
    .map((seat, sourceIdx) => ({
      seat,
      sourceIdx,
      fallbackIdx: Number.isFinite(seat.idx) ? seat.idx as number : sourceIdx,
      kind: normalizeSeatKind(seat.kind),
      name: normalizeName(seat.name),
    }))
    .filter(({ kind }) => kind !== 'empty')
    .slice(0, RUNTIME_FACTION_IDS.length);

  const migratedSeats = activeSeatSources
    .map(({ seat, sourceIdx, fallbackIdx, kind, name }, runtimeIdx) => {
      const seatFactionId = (
        typeof seat.factionId === 'string' && RUNTIME_FACTION_IDS.includes(seat.factionId as FactionId)
          ? seat.factionId as FactionId
          : RUNTIME_FACTION_IDS[runtimeIdx] ?? RUNTIME_FACTION_IDS[0]
      );
      const presetId = asPresetId(seat.factionPresetId)
        ?? legacySeatFallbackByFaction.get(seatFactionId)
        ?? FACTION_PRESETS[runtimeIdx]?.id
        ?? DEFAULT_PRESET_ID;
      return {
        ...seat,
        kind,
        name,
        idx: Number.isFinite(seat.idx) ? seat.idx as number : (Number.isFinite(sourceIdx) ? sourceIdx : fallbackIdx),
        factionId: seatFactionId,
        factionPresetId: presetId,
      };
    });
  const parsedActiveSeatIdx = parsed.activeSeatIdx as number;
  const activeSeatRuntimeRank = parsed.seats
    .slice(0, parsedActiveSeatIdx + 1)
    .map((seat) => normalizeSeatKind(seat.kind))
    .filter((kind) => kind !== 'empty')
    .length - 1;
  const migratedActiveSeatIdx = (() => {
    if (migratedSeats.length === 0) return 0;
    const activeRuntimeIdx = migratedSeats.findIndex((seat) => seat.idx === parsedActiveSeatIdx);
    if (activeRuntimeIdx >= 0) return migratedSeats[activeRuntimeIdx].idx;
    const activeSourceIdx = activeSeatSources.findIndex(({ sourceIdx }) => sourceIdx === parsedActiveSeatIdx);
    const migratedIdxAtRank = (rank: number): number => migratedSeats[rank]?.idx ?? migratedSeats[0].idx;
    if (activeSourceIdx >= 0) return migratedIdxAtRank(activeSourceIdx);
    if (activeSeatRuntimeRank < 0) return migratedSeats[0].idx;
    return migratedIdxAtRank(Math.min(activeSeatRuntimeRank, migratedSeats.length - 1));
  })();
  const migratedConfig = migrateConfig(parsed.config, migratedSeats);
  if (!migratedConfig) return null;
  if (migratedSeats.length < 2) return null;
  if (migratedSeats.some((seat) => !migratedFactions[seat.factionId])) return null;

  return fromSerializable({
    ...(parsed as SerializableGameState),
    // Pre-cardRng saves won't carry this field; derive a deterministic default
    // from the (validated, finite) seed so post-load reshuffles stay seeded.
    cardRng: Number.isFinite(parsed.cardRng)
      ? (parsed.cardRng as number)
      : deriveCardRngSeed(parsed.seed as number),
    seats: migratedSeats as SerializableGameState['seats'],
    activeSeatIdx: migratedActiveSeatIdx,
    config: migratedConfig,
    factions: migratedFactions as Record<FactionId, SerializableFactionState>,
  });
};

export const saveGame = (state: GameState): void => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const payload = toSerializable(state);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded or serialization error — silently drop. The user can
    // still play the live session; saves just won't persist.
  }
};

// How long to coalesce rapid-fire state changes into a single disk write.
// 200ms is short enough that even a fast ragequit-close preserves the last
// meaningful action, but long enough to avoid writing a ~100KB JSON blob
// on every pointer event during unit selection / cursor movement.
const SAVE_DEBOUNCE_MS = 200;

// Trailing debounce wrapper around saveGame. Each call schedules a write
// after SAVE_DEBOUNCE_MS; subsequent calls within that window cancel the
// pending write and schedule a fresh one, so only the most-recent state
// actually hits the disk. `flushPendingSave` runs any scheduled write
// immediately (useful before unmount or clearSave).
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: GameState | null = null;

export const debouncedSaveGame = (state: GameState): void => {
  pendingState = state;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (pendingState) {
      saveGame(pendingState);
      pendingState = null;
    }
  }, SAVE_DEBOUNCE_MS);
};

export const flushPendingSave = (): void => {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pendingState) {
    saveGame(pendingState);
    pendingState = null;
  }
};

export const loadGame = (): GameState | null => {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return migrateLoadedGameState(parsed);
  } catch {
    return null;
  }
};

export const clearSave = (): void => {
  // Cancel any debounced write in flight so it doesn't immediately restore
  // the save we're trying to clear.
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingState = null;
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};

export const hasSave = (): boolean => {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
};
