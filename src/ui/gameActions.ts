import type {
  AttackTarget, BuildingId, Card, FactionId, FactionState, GameState, UnitType,
} from '../game/types';
import { TERRAIN, UNIT_TYPES, BUILDINGS, BUILDING_REQUIREMENT } from '../game/constants';
import { hexKey, neighbors } from '../game/hex';
import { shuffle } from '../game/rng';
import { resolveUnitCombat, resolveCityAttack } from '../game/logic';
import { revealArea, checkVictory } from '../game/state';

// Handle a player attack from `attackerId` against `target` (unit or city).
// Returns the updated state, or the input state unchanged if the attack
// can't resolve (missing attacker or defender).
export const performPlayerAttack = (s: GameState, attackerId: number, target: AttackTarget): GameState => {
  const ns: GameState = {
    ...s,
    units: s.units.map((u) => ({ ...u })),
    cities: s.cities.map((c) => ({ ...c })),
    factions: { ...s.factions },
  };
  const atk = ns.units.find((u) => u.id === attackerId);
  if (!atk) return s;

  // Bump `totalKills` on the attacker's faction for stat-screen totals.
  // Clones the faction sub-object so we don't mutate the caller's state.
  const recordKill = (fid: FactionId): void => {
    const f = ns.factions[fid];
    if (!f) return;
    ns.factions[fid] = {
      ...f,
      totalKills: (f.totalKills || 0) + 1,
      buildings: new Set(f.buildings),
      explored: new Set(f.explored),
    };
  };

  let dmg: number;
  if (target.type === 'unit') {
    const defender = ns.units.find((u) => u.id === target.target.id);
    if (!defender) return s;
    dmg = resolveUnitCombat(atk, defender, {
      map: ns.map, units: ns.units,
      attackerFactionAmbush: ns.factions[atk.faction]?.ambushActive ?? false,
    });
    if (defender.hp <= 0) {
      ns.units = ns.units.filter((u) => u.id !== defender.id);
      recordKill(atk.faction);
      ns.log = [...ns.log.slice(-25), {
        turn: ns.turn, faction: atk.faction,
        text: `${UNIT_TYPES[atk.type].name} slays a ${UNIT_TYPES[defender.type].name}.`,
        hex: { q: defender.q, r: defender.r },
      }];
    } else {
      ns.log = [...ns.log.slice(-25), {
        turn: ns.turn, faction: atk.faction,
        text: `${UNIT_TYPES[atk.type].name} strikes for ${dmg}.`,
      }];
    }
  } else {
    const city = ns.cities.find((c) => c.id === target.target.id);
    if (!city) return s;
    dmg = resolveCityAttack(atk, city);
    if (city.hp <= 0) {
      ns.cities = ns.cities.filter((c) => c.id !== city.id);
      recordKill(atk.faction);
      ns.log = [...ns.log.slice(-25), {
        turn: ns.turn, faction: atk.faction,
        text: `${city.name} has fallen.`,
      }];
    } else {
      ns.log = [...ns.log.slice(-25), {
        turn: ns.turn, faction: atk.faction,
        text: `${UNIT_TYPES[atk.type].name} strikes ${city.name} for ${dmg}.`,
      }];
    }
  }

  atk.acted = true;
  atk.moved = UNIT_TYPES[atk.type].mov;
  if (atk.hp <= 0) ns.units = ns.units.filter((u) => u.id !== atk.id);

  const v = checkVictory(ns);
  ns.status = v.status === 'ended' ? 'ended' : ns.status;
  ns.winner = v.winner;
  return ns;
};

// Move a unit and reveal new tiles for that unit's faction. Snapshots
// the pre-move position + explored set into `undoBuffer` so the UNDO
// action can cleanly restore both. Any subsequent commit (attack, end
// turn, card play) clears the buffer — undo is single-step and only
// valid while the turn is still "open."
export const performMove = (s: GameState, unitId: number, q: number, r: number, moveCost: number): GameState => {
  const ns: GameState = {
    ...s,
    units: s.units.map((u) => ({ ...u })),
    factions: { ...s.factions },
  };
  const u = ns.units.find((x) => x.id === unitId);
  if (!u) return s;
  // Snapshot BEFORE applying the move.
  const preMovePos = { q: u.q, r: u.r, moved: u.moved };
  const preMoveExplored = Array.from(s.factions[u.faction].explored);
  u.q = q;
  u.r = r;
  u.moved += moveCost;
  const prev = ns.factions[u.faction];
  const next: FactionState = { ...prev, explored: new Set(prev.explored) };
  revealArea(next.explored, q, r, 1);
  ns.factions[u.faction] = next;
  ns.undoBuffer = {
    unitId,
    q: preMovePos.q,
    r: preMovePos.r,
    moved: preMovePos.moved,
    explored: preMoveExplored,
  };
  return ns;
};

// Recruit a unit at the given faction's city.
export const performRecruit = (s: GameState, factionId: FactionId, type: UnitType): GameState => {
  const def = UNIT_TYPES[type];
  const faction = s.factions[factionId];
  if (!faction) return s;
  if (faction.gold < def.cost.gold || faction.food < def.cost.food) return s;
  const city = s.cities.find((c) => c.faction === factionId);
  if (!city) return s;

  const candidates = [{ q: city.q, r: city.r }, ...neighbors(city.q, city.r)];
  const free = candidates.find((c) => {
    const tile = s.map[hexKey(c.q, c.r)];
    if (!tile || !TERRAIN[tile.type].passable) return false;
    return !s.units.find((u) => u.q === c.q && u.r === c.r);
  });
  if (!free) return s;

  const barracksBuff = (faction.buildings.has('barracks') ? 2 : 0)
    + (faction.buildings.has('barracks2') ? 2 : 0);
  const newUnit = {
    id: Math.max(0, ...s.units.map((u) => u.id)) + 1,
    type, faction: factionId,
    q: free.q, r: free.r,
    hp: def.hp + barracksBuff, maxHp: def.hp + barracksBuff,
    moved: def.mov, acted: true, atkBuff: 0, movBuff: 0, kills: 0, level: 0,
  };
  return {
    ...s,
    units: [...s.units, newUnit],
    factions: {
      ...s.factions,
      [factionId]: { ...faction, gold: faction.gold - def.cost.gold, food: faction.food - def.cost.food },
    },
    log: [
      ...s.log.slice(-25),
      { turn: s.turn, faction: factionId, text: `A ${def.name}${barracksBuff ? ' (veteran)' : ''} enlists in ${faction.name}.` },
    ],
  };
};

// Construct a building for the given faction. Guards the tier-2
// upgrades on their prerequisite (Bastion requires Walls, etc.).
export const performBuild = (s: GameState, factionId: FactionId, bldgId: BuildingId): GameState => {
  const bldg = BUILDINGS[bldgId];
  const faction = s.factions[factionId];
  if (!bldg || !faction) return s;
  if (faction.buildings.has(bldgId)) return s;
  if (faction.gold < bldg.cost.gold || faction.food < bldg.cost.food) return s;
  const requirement = BUILDING_REQUIREMENT[bldgId];
  if (requirement && !faction.buildings.has(requirement)) return s;

  const ns: GameState = {
    ...s,
    cities: s.cities.map((c) => ({ ...c })),
    factions: { ...s.factions },
  };
  const f: FactionState = {
    ...faction,
    buildings: new Set(faction.buildings),
    explored: new Set(faction.explored),
    gold: faction.gold - bldg.cost.gold,
    food: faction.food - bldg.cost.food,
  };
  f.buildings.add(bldgId);
  if (bldgId === 'walls' || bldgId === 'walls2') {
    ns.cities = ns.cities.map((c) =>
      c.faction === factionId ? { ...c, maxHp: c.maxHp + 15, hp: c.hp + 15 } : c
    );
  }
  if (bldgId === 'watchtower') {
    const city = ns.cities.find((c) => c.faction === factionId);
    if (city) revealArea(f.explored, city.q, city.r, 3);
  }
  if (bldgId === 'war_council') {
    f.orders = Math.max(f.orders, 4);
  }
  ns.factions[factionId] = f;
  ns.log = [...s.log.slice(-25), { turn: s.turn, faction: factionId, text: `${bldg.name} constructed in ${faction.name}.` }];
  return ns;
};

// Play a non-targeted card (rally, harvest, muster, feast).
export const performPlayUntargetedCard = (s: GameState, factionId: FactionId, card: Card): GameState => {
  const faction = s.factions[factionId];
  // Reject if the faction is missing, can't afford the order cost, or the
  // card isn't actually in hand. The orders/affordability check used to be
  // the only guard; the hand-membership check makes the helper safe to call
  // from non-UI code (the AI) without smuggling in a card the seat doesn't hold.
  if (!faction || faction.orders < card.cost
      || !faction.hand.some((c) => c.uid === card.uid)) return s;
  const ns: GameState = {
    ...s,
    units: s.units.map((u) => ({ ...u })),
    factions: { ...s.factions },
  };
  const f: FactionState = {
    ...faction,
    hand: faction.hand.filter((c) => c.uid !== card.uid),
    discard: [...faction.discard, card],
    deck: [...faction.deck],
    orders: faction.orders - card.cost,
  };
  let logMsg = '';
  if (card.id === 'rally') {
    ns.units.forEach((u) => { if (u.faction === factionId) u.atkBuff += 2; });
    logMsg = `${f.displayName}'s banners rise — host rallied!`;
  } else if (card.id === 'harvest') {
    f.gold += 6;
    logMsg = `${f.displayName} gains 6 gold.`;
  } else if (card.id === 'muster') {
    let deck = f.deck;
    let disc = [...f.discard];
    const hand = [...f.hand];
    for (let i = 0; i < 2; i++) {
      if (!deck.length && disc.length) { deck = shuffle(disc); disc = []; }
      const drawn = deck.pop();
      if (drawn) hand.push(drawn);
    }
    f.deck = deck;
    f.discard = disc;
    f.hand = hand;
    logMsg = `${f.displayName} musters new plans.`;
  } else if (card.id === 'feast') {
    f.gold += 4;
    f.food += 4;
    logMsg = `${f.displayName} hosts a Royal Feast.`;
  } else if (card.id === 'ambush') {
    f.ambushActive = true;
    logMsg = `${f.displayName} sets an Ambush — +3 attack this turn.`;
  }
  // Every successful card play contributes to the end-of-game tally.
  f.totalCardsPlayed = (f.totalCardsPlayed || 0) + 1;
  ns.factions[factionId] = f;
  ns.log = [...s.log.slice(-25), { turn: s.turn, faction: factionId, text: logMsg }];
  return ns;
};

// Resolve a targeted card play. Returns the new state and whether the click
// landed on a valid target (so the UI knows whether to keep targeting mode).
export const performPlayTargetedCard = (
  s: GameState, factionId: FactionId, card: Card, q: number, r: number,
): { state: GameState; valid: boolean } => {
  const faction = s.factions[factionId];
  if (!faction) return { state: s, valid: false };
  // Orders + hand-membership guards mirror the untargeted helper. Targeted
  // play previously leaned on the UI pre-check (GameScreen gates the dispatch
  // on faction.orders >= card.cost); doing it here too makes the resolver the
  // single source of truth and safe for the AI to call directly. Both return
  // valid:false so callers leave state untouched.
  if (faction.orders < card.cost) return { state: s, valid: false };
  if (!faction.hand.some((c) => c.uid === card.uid)) return { state: s, valid: false };
  const ns: GameState = {
    ...s,
    units: s.units.map((u) => ({ ...u })),
    cities: s.cities.map((c) => ({ ...c })),
    factions: { ...s.factions },
  };
  const f: FactionState = {
    ...faction,
    hand: [...faction.hand],
    discard: [...faction.discard],
    explored: new Set(faction.explored),
  };
  const unitAt = ns.units.find((u) => u.q === q && u.r === r);
  const cityAt = ns.cities.find((c) => c.q === q && c.r === r);
  let valid = false;
  let effectLog = '';

  if (card.target === 'ally_unit' && unitAt && unitAt.faction === factionId) {
    if (card.id === 'march') { unitAt.movBuff += 2; effectLog = `${UNIT_TYPES[unitAt.type].name} marches forth.`; valid = true; }
    else if (card.id === 'heal') { unitAt.hp = Math.min(unitAt.maxHp, unitAt.hp + 5); effectLog = `${UNIT_TYPES[unitAt.type].name} is mended.`; valid = true; }
  } else if (card.target === 'enemy_unit' && unitAt && unitAt.faction !== factionId) {
    if (f.explored.has(hexKey(q, r))) {
      if (card.id === 'hex') {
        unitAt.hp -= 4;
        if (unitAt.hp <= 0) {
          ns.units = ns.units.filter((u) => u.id !== unitAt.id);
          // A unit killed via Curse still counts as a kill for the
          // playing faction's end-of-game stats, matching direct
          // attacks.
          f.totalKills = (f.totalKills || 0) + 1;
        }
        effectLog = `A curse withers a ${UNIT_TYPES[unitAt.type].name}.`;
        valid = true;
      } else if (card.id === 'sabotage') {
        // Drain the target's *faction* economy, not the unit. Gold/food
        // can't go negative — the enemy just loses what they had.
        const enemyF = ns.factions[unitAt.faction];
        if (enemyF) {
          const newEnemy: FactionState = {
            ...enemyF,
            gold: Math.max(0, enemyF.gold - 3),
            food: Math.max(0, enemyF.food - 2),
            buildings: new Set(enemyF.buildings),
            explored: new Set(enemyF.explored),
          };
          ns.factions[unitAt.faction] = newEnemy;
          effectLog = `Saboteurs strike ${enemyF.displayName} — -3 gold, -2 food.`;
          valid = true;
        }
      }
    }
  } else if (card.target === 'enemy_city' && cityAt && cityAt.faction !== factionId) {
    if (card.id === 'siege' && f.explored.has(hexKey(q, r))) {
      cityAt.hp -= 6;
      if (cityAt.hp <= 0) {
        ns.cities = ns.cities.filter((c) => c.id !== cityAt.id);
        // Siege-destroyed cities contribute to the playing faction's
        // totalKills, same as a unit-attack city kill.
        f.totalKills = (f.totalKills || 0) + 1;
        effectLog = `A siege engine levels ${cityAt.name}.`;
      } else {
        effectLog = `A siege engine batters ${cityAt.name} for 6 damage.`;
      }
      valid = true;
    }
  } else if (card.target === 'tile' && s.map[hexKey(q, r)]) {
    revealArea(f.explored, q, r, 2);
    effectLog = `${f.displayName}'s scouts map distant lands.`;
    valid = true;
  }
  if (!valid) return { state: s, valid: false };
  f.hand = f.hand.filter((c) => c.uid !== card.uid);
  f.discard.push(card);
  f.orders -= card.cost;
  f.totalCardsPlayed = (f.totalCardsPlayed || 0) + 1;
  ns.factions[factionId] = f;
  ns.targeting = null;
  ns.log = [...s.log.slice(-25), { turn: s.turn, faction: factionId, text: effectLog }];
  const v = checkVictory(ns);
  ns.status = v.status === 'ended' ? 'ended' : ns.status;
  ns.winner = v.winner;
  return { state: ns, valid: true };
};
