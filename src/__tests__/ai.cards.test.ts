import { describe, expect, it } from 'vitest';
import type { Card, CardId, FactionId } from '../game/types';
import { CARD_POOL } from '../game/constants';
import { initialState } from '../game/state';
import { applyStartOfSeatTurn } from '../game/turn';
import { runAICardPhase, runAITurnFor } from '../game/ai';
import { performPlayTargetedCard, performPlayUntargetedCard } from '../ui/gameActions';
import { hexKey } from '../game/hex';
import { cloneState, mkConfig } from './helpers';

// Stable, named card with a deterministic uid (mirrors cards.test.ts).
const forceCard = (factionId: FactionId, id: CardId): Card => {
  const tpl = CARD_POOL.find((c) => c.id === id)!;
  return { ...tpl, uid: `${factionId}:${tpl.id}#test` };
};

// 1 human + 1 AI so seat[1] is reliably an AI faction.
const humanVsAI = (seed: number) => initialState(mkConfig({
  seed,
  seats: [
    { kind: 'human', name: 'P1' },
    { kind: 'ai', name: 'AI' },
    { kind: 'empty', name: '' },
    { kind: 'empty', name: '' },
  ],
}));

describe('AI participates in the card economy: dealing + drawing', () => {
  it('AI factions are dealt the same 4-card opening hand as humans', () => {
    const s = humanVsAI(1);
    const humanId = s.seats[0].factionId;
    const aiId = s.seats[1].factionId;
    expect(s.factions[humanId].kind).toBe('human');
    expect(s.factions[aiId].kind).toBe('ai');
    // Both seats are dealt 4. seat 0 (the human) is the only seat whose
    // start-of-turn housekeeping has run during initialState, so it has
    // already drawn its first card (4 + 1 = 5). The AI hasn't taken a turn
    // yet, so it still holds exactly the 4 it was dealt — the fix's core
    // claim (it used to be 0).
    expect(s.factions[aiId].hand.length).toBe(4);
    expect(s.factions[humanId].hand.length).toBe(5);
  });

  it('AI draws at the start of its turn under the same rule as humans', () => {
    const s0 = humanVsAI(2);
    const aiId = s0.seats[1].factionId;
    const s = cloneState(s0);
    // Thin the hand so a draw is observable and below the 7-card cap.
    s.factions[aiId].hand = s.factions[aiId].hand.slice(0, 2);
    const handBefore = s.factions[aiId].hand.length;
    const deckBefore = s.factions[aiId].deck.length;
    applyStartOfSeatTurn(s, aiId);
    // Base draw is 1/turn (no Tavern): hand +1, deck -1.
    expect(s.factions[aiId].hand.length).toBe(handBefore + 1);
    expect(s.factions[aiId].deck.length).toBe(deckBefore - 1);
  });
});

describe('AI card play via runAICardPhase', () => {
  it('plays an affordable untargeted card and records it in totalCardsPlayed', () => {
    const s0 = humanVsAI(3);
    const aiId = s0.seats[1].factionId;
    const s = cloneState(s0);
    const harvest = forceCard(aiId, 'harvest'); // cost 0, +6 gold
    s.factions[aiId].hand = [harvest];
    s.factions[aiId].orders = 3;
    const goldBefore = s.factions[aiId].gold;
    const playedBefore = s.factions[aiId].totalCardsPlayed;
    runAICardPhase(s, aiId);
    expect(s.factions[aiId].gold).toBe(goldBefore + 6);
    expect(s.factions[aiId].totalCardsPlayed).toBe(playedBefore + 1);
    expect(s.factions[aiId].hand.some((c) => c.uid === harvest.uid)).toBe(false);
    expect(s.factions[aiId].discard.some((c) => c.uid === harvest.uid)).toBe(true);
  });

  it('does not play a card it cannot afford', () => {
    const s0 = humanVsAI(4);
    const aiId = s0.seats[1].factionId;
    const s = cloneState(s0);
    const rally = forceCard(aiId, 'rally'); // cost 2
    s.factions[aiId].hand = [rally];
    s.factions[aiId].orders = 1; // can't afford
    runAICardPhase(s, aiId);
    expect(s.factions[aiId].totalCardsPlayed).toBe(0);
    expect(s.factions[aiId].orders).toBe(1);
    expect(s.factions[aiId].hand.some((c) => c.uid === rally.uid)).toBe(true);
  });

  it('plays an offensive targeted card against an explored enemy unit', () => {
    const s0 = humanVsAI(5);
    const humanId = s0.seats[0].factionId;
    const aiId = s0.seats[1].factionId;
    const s = cloneState(s0);
    const enemy = s.units.find((u) => u.faction === humanId)!;
    const hex = forceCard(aiId, 'hex'); // cost 2, 4 dmg, requires explored tile
    s.factions[aiId].hand = [hex];
    s.factions[aiId].orders = 3;
    // Reveal ONLY the enemy's tile so it is the single legal curse target.
    s.factions[aiId].explored = new Set([hexKey(enemy.q, enemy.r)]);
    const hpBefore = s.units.find((u) => u.id === enemy.id)!.hp;
    runAICardPhase(s, aiId);
    expect(s.factions[aiId].totalCardsPlayed).toBe(1);
    const post = s.units.find((u) => u.id === enemy.id);
    if (post) expect(post.hp).toBe(hpBefore - 4);
    else expect(hpBefore).toBeLessThanOrEqual(4); // 4 dmg was lethal
  });

  it('does NOT play an offensive targeted card when no legal (explored) target exists', () => {
    const s0 = humanVsAI(6);
    const humanId = s0.seats[0].factionId;
    const aiId = s0.seats[1].factionId;
    const s = cloneState(s0);
    const enemy = s.units.find((u) => u.faction === humanId)!;
    const hex = forceCard(aiId, 'hex');
    s.factions[aiId].hand = [hex];
    s.factions[aiId].orders = 3;
    s.factions[aiId].explored = new Set(); // nothing explored → no legal target
    const hpBefore = s.units.find((u) => u.id === enemy.id)!.hp;
    runAICardPhase(s, aiId);
    expect(s.factions[aiId].totalCardsPlayed).toBe(0);
    expect(s.units.find((u) => u.id === enemy.id)!.hp).toBe(hpBefore);
  });
});

describe('runAITurnFor includes the card phase', () => {
  it('AI plays at least one card during a full AI turn', () => {
    const s0 = humanVsAI(7);
    const aiId = s0.seats[1].factionId;
    const s = cloneState(s0);
    // A free, always-useful card guarantees the phase fires at least once.
    s.factions[aiId].hand = [forceCard(aiId, 'harvest')];
    s.factions[aiId].orders = 3;
    runAITurnFor(s, aiId);
    expect(s.factions[aiId].totalCardsPlayed).toBeGreaterThanOrEqual(1);
  });
});

describe('card resolver hardening (safe for non-UI callers)', () => {
  it('performPlayTargetedCard rejects insufficient orders without mutating', () => {
    const s0 = humanVsAI(8);
    const f1 = s0.seats[0].factionId;
    const s = cloneState(s0);
    const unit = s.units.find((u) => u.faction === f1)!;
    const march = forceCard(f1, 'march'); // cost 1, ally_unit
    s.factions[f1].hand = [march];
    s.factions[f1].orders = 0; // can't afford
    const { state: after, valid } = performPlayTargetedCard(s, f1, march, unit.q, unit.r);
    expect(valid).toBe(false);
    expect(after).toBe(s);
  });

  it('performPlayTargetedCard rejects a card that is not in hand', () => {
    const s0 = humanVsAI(9);
    const f1 = s0.seats[0].factionId;
    const s = cloneState(s0);
    const unit = s.units.find((u) => u.faction === f1)!;
    const heal = forceCard(f1, 'heal'); // cost 1, ally_unit
    s.factions[f1].hand = []; // NOT in hand
    s.factions[f1].orders = 3;
    const { state: after, valid } = performPlayTargetedCard(s, f1, heal, unit.q, unit.r);
    expect(valid).toBe(false);
    expect(after).toBe(s);
  });

  it('performPlayUntargetedCard rejects a card that is not in hand', () => {
    const s0 = humanVsAI(10);
    const f1 = s0.seats[0].factionId;
    const s = cloneState(s0);
    const harvest = forceCard(f1, 'harvest');
    s.factions[f1].hand = []; // NOT in hand
    s.factions[f1].orders = 3;
    const after = performPlayUntargetedCard(s, f1, harvest);
    expect(after).toBe(s);
  });
});
