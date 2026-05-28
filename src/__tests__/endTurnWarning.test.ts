import { describe, expect, it } from 'vitest';
import { initialState } from '../game/state';
import { factionHasUnmovedUnit } from '../game/logic';
import { hexKey, neighbors } from '../game/hex';
import { cloneState, mkConfig } from './helpers';

// Reduce the board to a single viewer unit at a known spot so the predicate's
// answer is fully controlled (no other unit can satisfy or block it).
const singleUnitState = (seed: number) => {
  const s = cloneState(initialState(mkConfig({ seed })));
  const fid = s.seats[0].factionId;
  const unit = s.units.find((u) => u.faction === fid)!;
  s.units = [unit];
  return { s, fid, unit };
};

// Paint a terrain ring around the unit using the SAME neighbor definition
// computeMoveRange uses, so the move-legality outcome is deterministic.
const ringTerrain = (s: ReturnType<typeof singleUnitState>['s'], q: number, r: number, type: 'grass' | 'mountain') => {
  neighbors(q, r).forEach((n) => {
    s.map[hexKey(n.q, n.r)] = { q: n.q, r: n.r, type };
  });
};

describe('factionHasUnmovedUnit (end-turn warning predicate)', () => {
  it('is true when a unit has not moved and has at least one legal move', () => {
    const { s, fid, unit } = singleUnitState(31);
    unit.moved = 0;
    ringTerrain(s, unit.q, unit.r, 'grass');
    expect(factionHasUnmovedUnit(s, fid)).toBe(true);
  });

  it('is false when the unit already spent movement — even if acted === false', () => {
    const { s, fid, unit } = singleUnitState(31);
    ringTerrain(s, unit.q, unit.r, 'grass');
    unit.moved = 1;       // has moved this turn
    unit.acted = false;   // not having attacked must NOT, by itself, trigger the warning
    expect(factionHasUnmovedUnit(s, fid)).toBe(false);
  });

  it('is false when an unmoved unit has no legal move (boxed in)', () => {
    const { s, fid, unit } = singleUnitState(31);
    unit.moved = 0;
    ringTerrain(s, unit.q, unit.r, 'mountain'); // impassable on all sides
    expect(factionHasUnmovedUnit(s, fid)).toBe(false);
  });

  it('is false when the faction has no units', () => {
    const { s, fid } = singleUnitState(31);
    s.units = [];
    expect(factionHasUnmovedUnit(s, fid)).toBe(false);
  });
});
