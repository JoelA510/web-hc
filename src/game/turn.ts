import type { FactionId, GameState, HexKey, Seat } from './types';
import { TERRAIN } from './constants';
import { hexKey, neighbors } from './hex';
import { seededShuffle } from './rng';
import { revealArea } from './state';

// Run end-of-turn housekeeping for one seat: yields, city regen, log entry.
// Mutates `ns` in place and appends to ns.log.
export const applyEndOfSeatTurn = (ns: GameState, factionId: FactionId): void => {
  const faction = ns.factions[factionId];
  if (!faction) return;
  const city = ns.cities.find((c) => c.faction === factionId);
  let goldGain = 2, foodGain = 2;
  if (city) {
    [{ q: city.q, r: city.r }, ...neighbors(city.q, city.r)].forEach((n) => {
      const tile = ns.map[hexKey(n.q, n.r)];
      if (tile) {
        const y = TERRAIN[tile.type].yield;
        goldGain += y.gold || 0;
        foodGain += y.food || 0;
      }
    });
    if (faction.buildings.has('market')) goldGain += 2;
    if (faction.buildings.has('market2')) goldGain += 2;
    if (faction.buildings.has('granary')) foodGain += 2;
    if (faction.buildings.has('granary2')) foodGain += 2;
    const wallsRegen = (faction.buildings.has('walls') ? 2 : 0)
      + (faction.buildings.has('walls2') ? 2 : 0);
    city.hp = Math.min(city.maxHp, city.hp + 2 + wallsRegen);

    // Temple: heal 2 HP to each friendly unit within 3 hexes of the city
    // at end-of-turn. Capped at maxHp so it never overshoots level bonuses.
    if (faction.buildings.has('temple')) {
      ns.units.forEach((u) => {
        if (u.faction !== factionId) return;
        const dq = u.q - city.q, dr = u.r - city.r;
        const dist = (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
        if (dist <= 3) u.hp = Math.min(u.maxHp, u.hp + 2);
      });
    }
  }
  faction.gold += goldGain;
  faction.food += foodGain;
  ns.log = [...ns.log.slice(-25), {
    turn: ns.turn, faction: factionId,
    text: `${faction.displayName}: +${goldGain} gold, +${foodGain} food.`,
  }];
};

// Start-of-turn housekeeping for one seat: reset unit flags, refresh orders,
// draw cards, reveal around units/cities. Applies to whichever faction is
// starting its turn — human or AI — so both share one card economy. Only
// living seats reach here (via nextLivingSeat, or seat 0 at init).
export const applyStartOfSeatTurn = (ns: GameState, factionId: FactionId): void => {
  const faction = ns.factions[factionId];
  if (!faction) return;
  // Reset per-turn unit flags unconditionally. Rally is a "this turn only"
  // effect: the +2 atkBuff applied when the card was played lasts through
  // end-of-turn combat and is cleared here at the start of the next
  // rotation of this faction, matching the original prototype's behavior.
  ns.units.forEach((u) => {
    if (u.faction === factionId) {
      u.moved = 0;
      u.acted = false;
      u.movBuff = 0;
      u.atkBuff = 0;
    }
  });
  // Ambush is a "this turn only" buff just like Rally — clear at the
  // start of this faction's next rotation.
  faction.ambushActive = false;
  const ordersBonus = faction.buildings.has('war_council') ? 1 : 0;
  faction.orders = 3 + ordersBonus;

  const drawCount = 1 + (faction.buildings.has('tavern') ? 1 : 0);
  const deck = [...faction.deck];
  let discard = [...faction.discard];
  const hand = [...faction.hand];
  for (let i = 0; i < drawCount; i++) {
    if (hand.length >= 7) break;
    if (!deck.length && discard.length) {
      const { result, seed } = seededShuffle(discard, ns.cardRng);
      ns.cardRng = seed;
      deck.push(...result);
      discard = [];
    }
    const drawn = deck.pop();
    if (drawn) hand.push(drawn);
  }
  faction.deck = deck;
  faction.discard = discard;
  faction.hand = hand;

  const explored = new Set<HexKey>(faction.explored);
  ns.units.filter((u) => u.faction === factionId).forEach((u) => revealArea(explored, u.q, u.r, 1));
  ns.cities.filter((c) => c.faction === factionId).forEach((c) => {
    const radius = faction.buildings.has('watchtower') ? 3 : 2;
    revealArea(explored, c.q, c.r, radius);
  });
  faction.explored = explored;
};

// Find the next living seat after the given index, wrapping. Returns null
// if no living seats remain.
export const nextLivingSeat = (state: GameState, fromIdx: number): Seat | null => {
  const seats = state.seats;
  if (!seats.length) return null;
  const aliveFactionIds = new Set(state.cities.map((c) => c.faction));
  const fromPos = seats.findIndex((s) => s.idx === fromIdx);
  for (let step = 1; step <= seats.length; step++) {
    const seat = seats[(fromPos + step) % seats.length];
    if (aliveFactionIds.has(seat.factionId)) return seat;
  }
  return null;
};
