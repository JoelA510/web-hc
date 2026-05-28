import type { City, FactionId, GameState, Unit } from './types';
import { TERRAIN, UNIT_TYPES } from './constants';
import { hexKey, hexDistance, neighbors } from './hex';

// Returns true if (q,r) sits in the zone of control of an enemy unit —
// i.e. an adjacent hex contains a living enemy. Used by computeMoveRange
// to stop movement on the first hex that enters ZoC (classic 4X rule:
// you can enter ZoC but can't keep moving after that).
const hexIsInEnemyZoC = (state: GameState, q: number, r: number, ownFaction: Unit['faction']): boolean => {
  for (const nb of neighbors(q, r)) {
    const enemy = state.units.find((u) => u.q === nb.q && u.r === nb.r && u.faction !== ownFaction);
    if (enemy) return true;
  }
  return false;
};

// BFS across passable hexes, respecting friendly/enemy occupants. The
// search halts expansion from any hex that sits in an enemy's zone of
// control — you can step into ZoC, but not through it. Attacking an
// enemy is still possible from such a hex because attack targeting is
// range-based, not move-based.
export const computeMoveRange = (unit: Unit, state: GameState): Map<string, number> => {
  const reachable = new Map<string, number>();
  const maxMov = UNIT_TYPES[unit.type].mov + (unit.movBuff || 0) - (unit.moved || 0);
  if (maxMov <= 0) return reachable;

  const queue: Array<{ q: number; r: number; cost: number }> = [{ q: unit.q, r: unit.r, cost: 0 }];
  reachable.set(hexKey(unit.q, unit.r), 0);

  while (queue.length) {
    const { q, r, cost } = queue.shift()!;
    if (cost >= maxMov) continue;
    // ZoC check for the hex we're currently standing on: only the
    // *starting* hex exempt because we treat that as "we were already
    // there at turn start." If we *entered* this hex mid-path AND it's
    // in enemy ZoC, do not continue expanding from here.
    const isStart = q === unit.q && r === unit.r;
    if (!isStart && hexIsInEnemyZoC(state, q, r, unit.faction)) continue;
    for (const n of neighbors(q, r)) {
      const key = hexKey(n.q, n.r);
      const tile = state.map[key];
      if (!tile || !TERRAIN[tile.type].passable) continue;
      const unitAt = state.units.find((u) => u.q === n.q && u.r === n.r && u.id !== unit.id);
      if (unitAt) continue;
      const cityAt = state.cities.find((c) => c.q === n.q && c.r === n.r);
      if (cityAt && cityAt.faction !== unit.faction) continue;
      const newCost = cost + 1;
      const prev = reachable.get(key);
      if (prev === undefined || prev > newCost) {
        reachable.set(key, newCost);
        queue.push({ q: n.q, r: n.r, cost: newCost });
      }
    }
  }
  reachable.delete(hexKey(unit.q, unit.r));
  return reachable;
};

// Does the faction have at least one unit that hasn't moved this turn AND
// still has a legal hex to move into? Drives the End-Turn "unmoved units"
// warning. Deliberately keyed on movement only — NOT on `acted`: a unit that
// can still attack but has no move left shouldn't trip an "unmoved" warning,
// and a unit that already spent any movement (moved > 0, including one that
// attacked — performPlayerAttack sets moved to full) is excluded. Units with
// no legal move (surrounded / out of budget) yield an empty computeMoveRange
// and are skipped too. `state.units` only holds living units.
export const factionHasUnmovedUnit = (state: GameState, factionId: FactionId): boolean => {
  for (const u of state.units) {
    if (u.faction !== factionId) continue;
    if (u.moved > 0) continue;
    if (computeMoveRange(u, state).size === 0) continue;
    return true;
  }
  return false;
};

// Returns attack targets in range: any enemy unit or enemy city. Unit
// targets intentionally come before city targets because the UI activates
// the first target on a hex; when both share a tile, attacks hit the unit.
export type AttackTargetPayload =
  | { type: 'unit'; target: Unit }
  | { type: 'city'; target: City };

export const computeAttackTargets = (unit: Unit, state: GameState): AttackTargetPayload[] => {
  const targets: AttackTargetPayload[] = [];
  const range = UNIT_TYPES[unit.type].range;
  state.units.forEach((u) => {
    if (u.faction === unit.faction) return;
    if (hexDistance({ q: unit.q, r: unit.r }, { q: u.q, r: u.r }) <= range) {
      targets.push({ type: 'unit', target: u });
    }
  });
  state.cities.forEach((c) => {
    if (c.faction === unit.faction) return;
    if (hexDistance({ q: unit.q, r: unit.r }, { q: c.q, r: c.r }) <= range) {
      targets.push({ type: 'city', target: c });
    }
  });
  return targets;
};

// Mutates attacker/defender in place. Used for unit-vs-unit combat. The
// defender counter-attacks if still alive AND the attacker is within
// defender's range (melee range-1 trades; ranged 2 gets free hits when
// striking from outside melee range). Both attacker's and defender's
// current atkBuff (e.g. from Rally) are factored into the damage
// calculation. Terrain defense (forest +2, hills +1) subtracts from
// incoming damage, floored at 1. Flanking adds +1 to the attacker when
// the defender has 2+ adjacent enemies of the attacker's faction.
// Returns damage dealt by attacker.
export type CombatContext = {
  map: GameState['map'];
  units: GameState['units'];
  // Optional attacker-faction state. When `ambushActive` is set, attacks
  // against a defender that hasn't acted yet this turn gain +3 atk.
  attackerFactionAmbush?: boolean;
};

const terrainDefenseAt = (ctx: CombatContext | undefined, q: number, r: number): number => {
  if (!ctx) return 0;
  const tile = ctx.map[hexKey(q, r)];
  if (!tile) return 0;
  return TERRAIN[tile.type].defense;
};

// Count adjacent enemies of the attacker's faction around (q,r) — used
// to score a +1 flanking bonus when the defender is ganged up on. The
// attacker itself counts (if it's adjacent, which it will be for melee),
// so one buddy elsewhere adjacent to the defender is enough to trigger:
// 2 attackers vs 1 defender = flanking.
const flankingAlliesAround = (
  ctx: CombatContext | undefined, q: number, r: number,
  attackerFaction: Unit['faction'],
): number => {
  if (!ctx) return 0;
  let count = 0;
  for (const nb of neighbors(q, r)) {
    const found = ctx.units.find((u) => u.q === nb.q && u.r === nb.r);
    if (found && found.faction === attackerFaction) count++;
  }
  return count;
};

// XP/leveling constants. Kept here (not constants.ts) so the math lives
// next to the code that reads it — the level-up curve is combat-rule
// data, not static configuration.
const KILLS_PER_LEVEL = 2;
const MAX_LEVEL = 3;

// Current bonus atk for a unit derived from its level. Levels are earned
// by killing — each level adds +1 atk and +1 to the HP pool (applied at
// level-up time, not here).
export const levelAtkBonus = (unit: Unit): number => unit.level || 0;

// Apply a kill to the attacker: bump `kills`, level up on threshold
// (capped at MAX_LEVEL). On level-up, bump maxHp/hp by +1 (each level
// adds a durable +1 HP; attacker heals to new max as a reward).
const awardKill = (attacker: Unit): void => {
  attacker.kills = (attacker.kills || 0) + 1;
  const targetLevel = Math.min(MAX_LEVEL, Math.floor(attacker.kills / KILLS_PER_LEVEL));
  if (targetLevel > (attacker.level || 0)) {
    attacker.level = targetLevel;
    attacker.maxHp += 1;
    attacker.hp = attacker.maxHp;
  }
};

export const resolveUnitCombat = (attacker: Unit, defender: Unit, ctx?: CombatContext): number => {
  const atkType = UNIT_TYPES[attacker.type];
  const flankingAllies = flankingAlliesAround(ctx, defender.q, defender.r, attacker.faction);
  const flankBonus = flankingAllies >= 2 ? 1 : 0;
  // Ambush: +3 if the attacker's faction played Ambush this turn AND the
  // defender hasn't acted. "Un-acted enemies" is the slower/reactive half
  // of the roster; rewards preemptive strikes.
  const ambushBonus = (ctx?.attackerFactionAmbush && !defender.acted) ? 3 : 0;
  const raw = atkType.atk + (attacker.atkBuff || 0) + levelAtkBonus(attacker) + flankBonus + ambushBonus;
  const def = terrainDefenseAt(ctx, defender.q, defender.r);
  const dmg = Math.max(1, raw - def);
  defender.hp -= dmg;

  if (defender.hp > 0 &&
      hexDistance(attacker, defender) <= UNIT_TYPES[defender.type].range) {
    const defRaw = UNIT_TYPES[defender.type].atk + (defender.atkBuff || 0) + levelAtkBonus(defender);
    const atkTerrainDef = terrainDefenseAt(ctx, attacker.q, attacker.r);
    const counter = Math.max(1, Math.floor(defRaw * 0.6) - atkTerrainDef);
    attacker.hp -= counter;
    // If defender's counter kills attacker, award the defender a kill
    // for the moral victory (attacker is about to be removed by the
    // caller; caller won't mis-award).
    if (attacker.hp <= 0) awardKill(defender);
  }
  if (defender.hp <= 0) awardKill(attacker);
  return dmg;
};

// Mutates the city in place. Cities have no counter-attack. The city's
// intrinsic HP + walls building already represent its toughness, so we
// intentionally DON'T apply terrain defense to city attacks — keeps city
// damage predictable for timing the last-city kill. Killing a city
// counts as a kill for the attacker (biggest possible prize).
export const resolveCityAttack = (attacker: Unit, city: City): number => {
  const atkType = UNIT_TYPES[attacker.type];
  const dmg = Math.max(1, atkType.atk + (attacker.atkBuff || 0) + levelAtkBonus(attacker));
  city.hp -= dmg;
  if (city.hp <= 0) awardKill(attacker);
  return dmg;
};

// Pure pathfinder used by the AI to approach an enemy for attack. BFS to
// `target`, returning the ordered list of hex coords the unit should step
// through, starting from the first hex *after* `start`.
//
// Importantly, if `target` itself is reachable (e.g. an adjacent enemy),
// the returned path stops at the hex *adjacent* to `target` — it does NOT
// include the target tile. This is intentional: the AI is expected to end
// its movement next to an enemy and then attack, not walk onto the enemy's
// tile. If `target` is unreachable, the path ends at the reachable hex
// whose hex distance to `target` is smallest (inclusive of that hex).
// Callers that need a path that *enters* a tile should look elsewhere
// (e.g. computeMoveRange for player-driven movement).
export const findPathToward = (
  unit: Unit,
  target: { q: number; r: number },
  state: GameState,
): Array<{ q: number; r: number }> => {
  const start = { q: unit.q, r: unit.r };
  const visited = new Map<string, { q: number; r: number } | null>();
  visited.set(hexKey(start.q, start.r), null);
  const queue: Array<{ q: number; r: number }> = [start];

  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.q === target.q && cur.r === target.r) break;
    for (const n of neighbors(cur.q, cur.r)) {
      const key = hexKey(n.q, n.r);
      if (visited.has(key)) continue;
      const tile = state.map[key];
      if (!tile || !TERRAIN[tile.type].passable) continue;
      const isTarget = n.q === target.q && n.r === target.r;
      if (!isTarget) {
        const unitAt = state.units.find((u) => u.q === n.q && u.r === n.r);
        if (unitAt) continue;
        const cityAt = state.cities.find((c) => c.q === n.q && c.r === n.r);
        if (cityAt) continue;
      }
      visited.set(key, { q: cur.q, r: cur.r });
      queue.push(n);
    }
  }

  const targetKey = hexKey(target.q, target.r);
  let endCoord: { q: number; r: number } | null = null;
  if (visited.has(targetKey)) {
    endCoord = visited.get(targetKey) ?? null;
  } else {
    let bestKey: string | null = null;
    let bestD = Infinity;
    for (const k of visited.keys()) {
      const [q, r] = k.split(',').map(Number);
      const d = hexDistance({ q, r }, target);
      if (d < bestD) { bestD = d; bestKey = k; }
    }
    if (bestKey) {
      const [q, r] = bestKey.split(',').map(Number);
      endCoord = { q, r };
    }
  }
  if (!endCoord) return [];
  const path: Array<{ q: number; r: number }> = [];
  let cur: { q: number; r: number } | null = endCoord;
  while (cur && (cur.q !== start.q || cur.r !== start.r)) {
    path.unshift(cur);
    cur = visited.get(hexKey(cur.q, cur.r)) ?? null;
  }
  return path;
};
