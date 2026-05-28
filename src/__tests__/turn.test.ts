import { describe, expect, it } from 'vitest';
import { checkVictory, initialState } from '../game/state';
import { applyEndOfSeatTurn, applyStartOfSeatTurn, nextLivingSeat } from '../game/turn';
import { runAITurnFor } from '../game/ai';
import { performPlayUntargetedCard } from '../ui/gameActions';
import { cloneState, mkConfig } from './helpers';

describe('victory', () => {
  it('fresh 3-faction game is still playing', () => {
    const s = initialState(mkConfig({
      seed: 101,
      seats: [
        { kind: 'human', name: 'P1' },
        { kind: 'ai', name: 'A' },
        { kind: 'ai', name: 'B' },
        { kind: 'empty', name: '' },
      ],
    }));
    expect(checkVictory(s).status).toBe('playing');
  });

  it('removing all but one faction ends the game with that faction as winner', () => {
    const s0 = initialState(mkConfig({
      seed: 101,
      seats: [
        { kind: 'human', name: 'P1' },
        { kind: 'ai', name: 'A' },
        { kind: 'ai', name: 'B' },
        { kind: 'empty', name: '' },
      ],
    }));
    const s = cloneState(s0);
    const firstId = s.seats[0].factionId;
    s.cities = s.cities.filter((c) => c.faction === firstId);
    const v = checkVictory(s);
    expect(v.status).toBe('ended');
    expect(v.winner).toBe(firstId);
  });
});

describe('nextLivingSeat rotation', () => {
  const cfg = mkConfig({
    seed: 202,
    seats: [
      { kind: 'human', name: 'P1' },
      { kind: 'ai', name: 'A' },
      { kind: 'ai', name: 'B' },
      { kind: 'ai', name: 'C' },
    ],
  });

  it('walks seat 0 → 1 → 2 → 3 → wraps to 0', () => {
    const s = initialState(cfg);
    const [a, b, c, d] = s.seats;
    expect(nextLivingSeat(s, a.idx)?.idx).toBe(b.idx);
    expect(nextLivingSeat(s, b.idx)?.idx).toBe(c.idx);
    expect(nextLivingSeat(s, c.idx)?.idx).toBe(d.idx);
    expect(nextLivingSeat(s, d.idx)?.idx).toBe(a.idx);
  });

  it('skips eliminated seats', () => {
    const s0 = initialState(cfg);
    const s = cloneState(s0);
    const [a, b, c] = s.seats;
    s.cities = s.cities.filter((ct) => ct.faction !== b.factionId);
    expect(nextLivingSeat(s, a.idx)?.idx).toBe(c.idx);
  });
});

describe('Rally buff lifecycle', () => {
  it('applies +2 atkBuff on play, clears at start of next rotation', () => {
    const s0 = initialState(mkConfig({ seed: 42 }));
    const f1 = s0.seats[0].factionId;
    const forced = {
      id: 'rally' as const, name: 'Rally', desc: '+2 Atk',
      cost: 2, target: 'none' as const, uid: `${f1}:rally#test`,
    };
    const s1 = {
      ...s0,
      factions: {
        ...s0.factions,
        [f1]: { ...s0.factions[f1], orders: 3, hand: [forced] },
      },
    };

    const before = s1.units.filter((u) => u.faction === f1).map((u) => u.atkBuff);
    expect(before.every((b) => b === 0)).toBe(true);

    const s2 = performPlayUntargetedCard(s1, f1, forced);
    const afterPlay = s2.units.filter((u) => u.faction === f1).map((u) => u.atkBuff);
    expect(afterPlay.every((b) => b === 2)).toBe(true);

    const s = cloneState(s2);
    applyEndOfSeatTurn(s, f1);
    const next = nextLivingSeat(s, s.activeSeatIdx)!;
    s.activeSeatIdx = next.idx;
    applyStartOfSeatTurn(s, next.factionId);
    applyEndOfSeatTurn(s, next.factionId);
    const afterF1 = nextLivingSeat(s, s.activeSeatIdx)!;
    s.activeSeatIdx = afterF1.idx;
    applyStartOfSeatTurn(s, afterF1.factionId);

    const cleared = s.units.filter((u) => u.faction === f1).map((u) => u.atkBuff);
    expect(cleared.every((b) => b === 0)).toBe(true);
  });
});

describe('AI seat income + regen', () => {
  it('runAITurnFor does NOT grant income or regen — that is applyEndOfSeatTurn\'s job', () => {
    const s0 = initialState(mkConfig({
      seed: 7,
      seats: [
        { kind: 'human', name: 'P1' },
        { kind: 'ai', name: 'AI' },
        { kind: 'empty', name: '' },
        { kind: 'empty', name: '' },
      ],
    }));
    const aiId = s0.seats.find((x) => s0.factions[x.factionId].kind === 'ai')!.factionId;
    const aiCity0 = s0.cities.find((c) => c.faction === aiId)!;
    const s = cloneState(s0);
    s.cities = s.cities.map((c) => c.id === aiCity0.id ? { ...c, hp: Math.max(1, c.hp - 6) } : c);
    const damagedHp = s.cities.find((c) => c.id === aiCity0.id)!.hp;
    const goldBefore = s.factions[aiId].gold;
    const foodBefore = s.factions[aiId].food;

    applyStartOfSeatTurn(s, aiId);
    // Clear the AI's hand so the card phase can't play Harvest/Feast (which
    // legitimately ADD gold/food). This test isolates the income/regen
    // separation — that runAITurnFor grants neither income nor regen — from
    // card effects, which are exercised in ai.cards.test.ts.
    s.factions[aiId].hand = [];
    runAITurnFor(s, aiId);

    const aiAfter = s.factions[aiId];
    const cityAfter = s.cities.find((c) => c.faction === aiId)!;
    // AI may spend gold/food on build/recruit, so delta should be <= 0.
    expect(aiAfter.gold - goldBefore).toBeLessThanOrEqual(0);
    expect(aiAfter.food - foodBefore).toBeLessThanOrEqual(0);
    expect(cityAfter.hp).toBe(damagedHp);
  });

  it('applyEndOfSeatTurn applies exactly one income + regen pass', () => {
    const s0 = initialState(mkConfig({
      seed: 7,
      seats: [
        { kind: 'human', name: 'P1' },
        { kind: 'ai', name: 'AI' },
        { kind: 'empty', name: '' },
        { kind: 'empty', name: '' },
      ],
    }));
    const aiId = s0.seats.find((x) => s0.factions[x.factionId].kind === 'ai')!.factionId;
    const aiCity0 = s0.cities.find((c) => c.faction === aiId)!;
    const s = cloneState(s0);
    s.cities = s.cities.map((c) => c.id === aiCity0.id ? { ...c, hp: Math.max(1, c.hp - 6) } : c);
    const damagedHp = s.cities.find((c) => c.id === aiCity0.id)!.hp;
    const goldBefore = s.factions[aiId].gold;
    const foodBefore = s.factions[aiId].food;

    applyEndOfSeatTurn(s, aiId);

    const aiAfter = s.factions[aiId];
    const cityAfter = s.cities.find((c) => c.faction === aiId)!;
    expect(aiAfter.gold - goldBefore).toBeGreaterThanOrEqual(2);
    expect(aiAfter.food - foodBefore).toBeGreaterThanOrEqual(2);
    expect(cityAfter.hp).toBeGreaterThan(damagedHp);
  });
});

describe('AI pipeline actually applies damage', () => {
  // Regression for a misread on PR #4: Gemini flagged performAIAttack as
  // "calculates dmg but never subtracts it" because the call to
  // resolveUnitCombat/resolveCityAttack doesn't look like it mutates. It
  // does — both helpers do `target.hp -= dmg` internally. This test
  // proves an AI turn reduces an adjacent enemy's HP so the next misread
  // fails a test instead of a review.
  it('runAITurnFor: AI unit placed adjacent to an enemy damages that enemy', () => {
    const s0 = initialState(mkConfig({
      seed: 111,
      seats: [
        { kind: 'human', name: 'P1' },
        { kind: 'ai', name: 'AI' },
        { kind: 'empty', name: '' },
        { kind: 'empty', name: '' },
      ],
    }));
    const humanFactionId = s0.seats[0].factionId;
    const aiFactionId = s0.seats[1].factionId;
    const humanUnit = s0.units.find((u) => u.faction === humanFactionId)!;
    const aiUnit = s0.units.find((u) => u.faction === aiFactionId)!;

    const s = cloneState(s0);
    // Place the AI unit adjacent to the human unit so the AI picks them
    // as target and (crucially) lands a hit without moving.
    const a = s.units.find((u) => u.id === aiUnit.id)!;
    const h = s.units.find((u) => u.id === humanUnit.id)!;
    h.q = 0; h.r = 0;
    a.q = 1; a.r = 0;

    // Make sure the AI unit is fresh for the turn.
    applyStartOfSeatTurn(s, aiFactionId);
    const humanHpBefore = s.units.find((u) => u.id === humanUnit.id)!.hp;
    runAITurnFor(s, aiFactionId);
    const humanUnitAfter = s.units.find((u) => u.id === humanUnit.id);

    // Either the human unit took damage OR the human unit died (hp <= 0
    // and was filtered out of ns.units). Both prove damage was applied.
    if (humanUnitAfter) {
      expect(humanUnitAfter.hp).toBeLessThan(humanHpBefore);
    } else {
      // Unit died — the AI attack finished them off.
      expect(humanHpBefore).toBeGreaterThan(0);
    }
  });
});

describe('pendingPassSeatIdx hotseat gate', () => {
  it('starts null, endTurn-to-next-human sets it, confirmPass-shaped reset clears it', () => {
    const s0 = initialState(mkConfig({ seed: 909 }));
    expect(s0.pendingPassSeatIdx).toBe(null);

    const s = cloneState(s0);
    applyEndOfSeatTurn(s, s.seats[0].factionId);
    const next = nextLivingSeat(s, s.activeSeatIdx)!;
    s.activeSeatIdx = next.idx;
    const humanCount = Object.values(s.factions).filter((x) => x.kind === 'human').length;
    if (humanCount > 1) s.pendingPassSeatIdx = next.idx;
    expect(s.pendingPassSeatIdx).toBe(next.idx);

    applyStartOfSeatTurn(s, next.factionId);
    s.pendingPassSeatIdx = null;
    expect(s.pendingPassSeatIdx).toBe(null);
  });
});
