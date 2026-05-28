import type { Card, CardId, City, FactionId, FactionState, GameState, Unit } from './types';
import {
  BUILDINGS, TERRAIN, UNIT_TYPES,
  LIVING_UNIT_TYPES, UNDEAD_UNIT_TYPES,
} from './constants';
import { hexDistance, hexKey, neighbors } from './hex';
import { findPathToward, resolveCityAttack, resolveUnitCombat } from './logic';
import { performPlayTargetedCard, performPlayUntargetedCard } from '../ui/gameActions';

type AITarget =
  | { q: number; r: number; ref: Unit; kind: 'unit' }
  | { q: number; r: number; ref: City; kind: 'city' };

// Picks targets for a single AI faction: any enemy unit or city (any
// non-same-faction entity counts as an enemy in N-way play).
const enemyTargetsFor = (ns: GameState, factionId: FactionId): AITarget[] => [
  ...ns.units
    .filter((u) => u.faction !== factionId)
    .map<AITarget>((u) => ({ q: u.q, r: u.r, ref: u, kind: 'unit' })),
  ...ns.cities
    .filter((c) => c.faction !== factionId)
    .map<AITarget>((c) => ({ q: c.q, r: c.r, ref: c, kind: 'city' })),
];

// AI attack helper. Delegates the damage + counter-attack math to the
// shared `resolveUnitCombat` / `resolveCityAttack` helpers in logic.ts
// so a fix to combat semantics (like the defender-atkBuff counter fix)
// automatically flows through to both player and AI attacks. This file
// owns only the bookkeeping: log entries, removing dead units/cities,
// and marking the attacker as acted.
const performAIAttack = (attacker: Unit, target: AITarget, ns: GameState): void => {
  const dmg = target.kind === 'unit'
    ? resolveUnitCombat(attacker, target.ref, {
        map: ns.map, units: ns.units,
        attackerFactionAmbush: ns.factions[attacker.faction]?.ambushActive ?? false,
      })
    : resolveCityAttack(attacker, target.ref);

  const targetLabel = target.kind === 'city' ? target.ref.name : UNIT_TYPES[target.ref.type].name;
  ns.log = [...ns.log.slice(-25), {
    turn: ns.turn, faction: attacker.faction,
    text: `${UNIT_TYPES[attacker.type].name} strikes ${targetLabel} for ${dmg}.`,
    hex: { q: target.ref.q, r: target.ref.r },
  }];

  const targetDied = (target.kind === 'unit' && target.ref.hp <= 0)
    || (target.kind === 'city' && target.ref.hp <= 0);
  if (target.kind === 'unit' && target.ref.hp <= 0) ns.units = ns.units.filter((u) => u.id !== target.ref.id);
  else if (target.kind === 'city' && target.ref.hp <= 0) ns.cities = ns.cities.filter((c) => c.id !== target.ref.id);
  if (attacker.hp <= 0) ns.units = ns.units.filter((u) => u.id !== attacker.id);
  attacker.acted = true;

  // Record the kill on the attacker's faction for end-of-game stats.
  if (targetDied) {
    const f = ns.factions[attacker.faction];
    if (f) {
      ns.factions = {
        ...ns.factions,
        [attacker.faction]: {
          ...f,
          totalKills: (f.totalKills || 0) + 1,
          buildings: new Set(f.buildings),
          explored: new Set(f.explored),
        },
      };
    }
  }
};

// --- AI card play -----------------------------------------------------------
//
// The AI spends its per-turn `orders` on cards through the SAME validated
// resolvers the human UI uses (performPlayUntargetedCard / performPlayTargetedCard)
// — no duplicated rule logic. Cards cost only orders, never gold/food, and
// don't compete with movement/combat/build/recruit (those aren't order-gated),
// so the AI can empty its order pool on cards and still act with its units.
//
// The policy is deterministic (no RNG in the choice) so "Play again (same
// setup)" stays reproducible and the behavior is testable. Targeted offensive
// cards are restricted to tiles in the faction's `explored` set, so the AI is
// not omniscient — it can only curse/sabotage/siege what it has revealed
// around its own units and cities.

type AICardPlay =
  | { kind: 'untargeted'; card: Card }
  | { kind: 'targeted'; card: Card; q: number; r: number };

// Will the AI likely attack this turn? True when some friendly unit has an
// enemy within its move+range reach. Gates the pre-combat buffs (Rally,
// Ambush) so the AI doesn't burn them on a quiet turn.
const aiWillEngage = (ns: GameState, factionId: FactionId): boolean => {
  const enemies = enemyTargetsFor(ns, factionId);
  if (!enemies.length) return false;
  return ns.units.some((u) => {
    if (u.faction !== factionId) return false;
    const reach = UNIT_TYPES[u.type].mov + UNIT_TYPES[u.type].range;
    return enemies.some((t) => hexDistance(u, t) <= reach);
  });
};

const cardInHand = (f: FactionState, id: CardId): Card | undefined =>
  f.hand.find((c) => c.id === id);

// Pick the single best card play for this faction given current state, or
// null when nothing is worth playing. Re-evaluated each loop iteration so the
// AI reacts to its own previous plays (e.g. Muster drawing into a Harvest).
// Priority order, highest first; every branch requires the card be affordable
// and in hand, and targeted picks pre-validate the target so the resolver
// never has to reject them.
const chooseAICardPlay = (ns: GameState, factionId: FactionId): AICardPlay | null => {
  const f = ns.factions[factionId];
  if (!f) return null;
  const affordable = (c: Card | undefined): c is Card => !!c && f.orders >= c.cost;
  const explored = (q: number, r: number): boolean => f.explored.has(hexKey(q, r));

  // 1. Harvest — free gold, always worth it.
  const harvest = cardInHand(f, 'harvest');
  if (affordable(harvest)) return { kind: 'untargeted', card: harvest };

  // 2/3. Pre-combat buffs — only when we expect to fight this turn.
  if (aiWillEngage(ns, factionId)) {
    const ambush = cardInHand(f, 'ambush');
    if (affordable(ambush)) return { kind: 'untargeted', card: ambush };
    const rally = cardInHand(f, 'rally');
    if (affordable(rally)) return { kind: 'untargeted', card: rally };
  }

  // 4. Siege — biggest prize: chip an explored enemy city, weakest first.
  const siege = cardInHand(f, 'siege');
  if (affordable(siege)) {
    const target = ns.cities
      .filter((c) => c.faction !== factionId && explored(c.q, c.r))
      .sort((a, b) => a.hp - b.hp)[0];
    if (target) return { kind: 'targeted', card: siege, q: target.q, r: target.r };
  }

  // 5. Curse — damage an explored enemy unit, weakest first (prefers a kill).
  const hex = cardInHand(f, 'hex');
  if (affordable(hex)) {
    const target = ns.units
      .filter((u) => u.faction !== factionId && explored(u.q, u.r))
      .sort((a, b) => a.hp - b.hp)[0];
    if (target) return { kind: 'targeted', card: hex, q: target.q, r: target.r };
  }

  // 6. Heal — mend the most-wounded ally that's missing a meaningful chunk.
  const heal = cardInHand(f, 'heal');
  if (affordable(heal)) {
    const target = ns.units
      .filter((u) => u.faction === factionId && u.maxHp - u.hp >= 4)
      .sort((a, b) => (b.maxHp - b.hp) - (a.maxHp - a.hp))[0];
    if (target) return { kind: 'targeted', card: heal, q: target.q, r: target.r };
  }

  // 7. Sabotage — drain an explored enemy unit's faction (needs resources to take).
  const sabotage = cardInHand(f, 'sabotage');
  if (affordable(sabotage)) {
    const target = ns.units
      .filter((u) => {
        if (u.faction === factionId || !explored(u.q, u.r)) return false;
        const ef = ns.factions[u.faction];
        return !!ef && ef.gold + ef.food > 0;
      })
      .sort((a, b) => a.id - b.id)[0];
    if (target) return { kind: 'targeted', card: sabotage, q: target.q, r: target.r };
  }

  // 8. Feast — economy.
  const feast = cardInHand(f, 'feast');
  if (affordable(feast)) return { kind: 'untargeted', card: feast };

  // 9. Muster — refill a thin hand when there are cards left to draw.
  const muster = cardInHand(f, 'muster');
  if (affordable(muster) && f.hand.length <= 3 && (f.deck.length + f.discard.length) > 0) {
    return { kind: 'untargeted', card: muster };
  }

  // Forced March and Scout are deliberately skipped: AI movement ignores
  // movBuff (March would be a no-op) and the generalized start-of-turn reveal
  // already gives the AI vision, so Scout would waste an order.
  return null;
};

// Spend the AI's orders on cards via the shared resolvers. Mutates `ns` in
// place to match runAITurnFor's contract: the resolvers return a fresh state,
// which we copy back onto the live object with Object.assign. The safety cap
// is a backstop — orders (3-4/turn) bound the real iteration count.
export const runAICardPhase = (ns: GameState, factionId: FactionId): void => {
  let safety = 16;
  while (safety-- > 0) {
    if (ns.status === 'ended') break;
    const f = ns.factions[factionId];
    if (!f || f.orders <= 0 || f.hand.length === 0) break;
    const play = chooseAICardPlay(ns, factionId);
    if (!play) break;
    if (play.kind === 'untargeted') {
      const after = performPlayUntargetedCard(ns, factionId, play.card);
      if (after === ns) break; // resolver rejected — stop (defensive; shouldn't happen)
      Object.assign(ns, after);
    } else {
      const { state: after, valid } = performPlayTargetedCard(ns, factionId, play.card, play.q, play.r);
      if (!valid) break; // defensive: targets are pre-validated above
      Object.assign(ns, after);
    }
  }
};

// Run the AI's mid-turn actions: card play, then unit movement/combat,
// recruiting, and construction. Assumes applyStartOfSeatTurn has already reset
// unit flags + drawn cards, and that applyEndOfSeatTurn will run afterwards to
// grant income and city regen uniformly across human and AI seats — do NOT
// duplicate those here.
export const runAITurnFor = (ns: GameState, factionId: FactionId): void => {
  if (!ns.factions[factionId]) return;

  // Card phase first: pre-combat buffs (Rally/Ambush) and economy cards should
  // land before the movement/combat/build/recruit phases read faction state.
  // runAICardPhase may replace ns.factions wholesale via Object.assign, so
  // capture `faction`/`city` only AFTER it runs.
  runAICardPhase(ns, factionId);
  if (ns.status === 'ended') return;

  const faction = ns.factions[factionId];
  if (!faction) return;
  const city = ns.cities.find((c) => c.faction === factionId);

  // Unit actions: threat-weighted target scoring. For each of our units we
  // consider every enemy unit+city and score them by (distance, hp, prize
  // value). A "prize" is a city (higher weight) or a weak unit about to
  // die. This beats pure greedy-nearest in N-way matches, where a unit
  // sandwiched between two enemies would otherwise thrash between targets.
  //
  // Score (lower = better):
  //   distance        — always matters most, gate by movement budget
  //   - city bonus    — cities end the game; commit to the closer attacker
  //   - low-hp bonus  — units at <= 1/3 hp are prioritized (finish them)
  // An ally-density "swarm" penalty was considered but intentionally left
  // out: in practice the AI is already under-aggressive, and spreading
  // units further only makes it worse. Add it later if swarm thrash shows
  // up in playtests.
  //
  // Snapshot ids of units we plan to act for, then re-resolve the unit
  // each iteration to skip any that died to a counter-attack earlier.
  const scoreTarget = (unit: Unit, t: AITarget): number => {
    const dist = hexDistance(unit, t);
    let score = dist;
    if (t.kind === 'city') score -= 2;
    if (t.kind === 'unit') {
      const defType = UNIT_TYPES[t.ref.type];
      if (t.ref.hp <= Math.ceil(defType.hp / 3)) score -= 1;
    }
    return score;
  };

  const myUnitIds = ns.units.filter((u) => u.faction === factionId).map((u) => u.id);
  for (const id of myUnitIds) {
    const unit = ns.units.find((u) => u.id === id);
    if (!unit) continue;
    const targets = enemyTargetsFor(ns, factionId);
    if (!targets.length) break;
    let best: AITarget | null = null;
    let bestScore = Infinity;
    let bestD = Infinity;
    targets.forEach((t) => {
      const s = scoreTarget(unit, t);
      if (s < bestScore) {
        bestScore = s;
        bestD = hexDistance(unit, t);
        best = t;
      }
    });
    if (!best) continue;

    const atkR = UNIT_TYPES[unit.type].range;
    if (bestD <= atkR) {
      performAIAttack(unit, best, ns);
      continue;
    }

    const path = findPathToward(unit, best, ns);
    if (path.length > 0) {
      const moveBudget = UNIT_TYPES[unit.type].mov;
      const step = Math.min(path.length, moveBudget);
      const destination = path[step - 1];
      unit.q = destination.q;
      unit.r = destination.r;
      unit.moved = step;
      if (hexDistance(unit, best) <= atkR) {
        performAIAttack(unit, best, ns);
      }
    }
  }

  // Construction (one per turn, priority order).
  // Priority order. Tier-2 upgrades slot in immediately after their base
  // so the AI keeps upgrading rather than branching wide.
  const buildOrder = [
    'granary', 'granary2', 'market', 'market2',
    'walls', 'walls2', 'barracks', 'barracks2',
    'temple',
  ] as const;
  for (const id of buildOrder) {
    if (faction.buildings.has(id)) continue;
    const bldg = BUILDINGS[id];
    if (faction.gold >= bldg.cost.gold && faction.food >= bldg.cost.food) {
      faction.buildings.add(id);
      faction.gold -= bldg.cost.gold;
      faction.food -= bldg.cost.food;
      if (id === 'walls' && city) {
        city.maxHp += 15;
        city.hp += 15;
      }
      ns.log = [...ns.log.slice(-25), { turn: ns.turn, faction: factionId, text: `${faction.name} raises ${bldg.name}.` }];
      break;
    }
  }

  // Recruit (deterministic: enlist whenever affordable and a spawn slot
  // exists — preserves reproducibility of "Play again (same setup)").
  if (city) {
    const pool = faction.unitPool === 'undead' ? UNDEAD_UNIT_TYPES : LIVING_UNIT_TYPES;
    for (const t of pool) {
      const def = UNIT_TYPES[t];
      if (faction.gold < def.cost.gold || faction.food < def.cost.food) continue;
      const candidates = [{ q: city.q, r: city.r }, ...neighbors(city.q, city.r)];
      const free = candidates.find((c) => {
        const tile = ns.map[hexKey(c.q, c.r)];
        return tile && TERRAIN[tile.type].passable && !ns.units.find((u) => u.q === c.q && u.r === c.r);
      });
      if (free) {
        const barracksBuff = (faction.buildings.has('barracks') ? 2 : 0)
          + (faction.buildings.has('barracks2') ? 2 : 0);
        ns.units.push({
          id: Math.max(0, ...ns.units.map((u) => u.id)) + 1,
          type: t, faction: factionId,
          q: free.q, r: free.r,
          hp: def.hp + barracksBuff, maxHp: def.hp + barracksBuff,
          moved: 0, acted: true, atkBuff: 0, movBuff: 0, kills: 0, level: 0,
        });
        faction.gold -= def.cost.gold;
        faction.food -= def.cost.food;
        ns.log = [...ns.log.slice(-25), { turn: ns.turn, faction: factionId, text: `A ${def.name} musters in ${faction.name}.` }];
        break;
      }
    }
  }
};
