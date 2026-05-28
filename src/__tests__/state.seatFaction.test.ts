import { describe, expect, it } from 'vitest';
import { FACTION_PRESETS } from '../game/constants';
import { activeSeats, initialState, makeStarterDeck } from '../game/state';
import type { GameConfig } from '../game/types';
import { mkConfig } from './helpers';

describe('seat/faction decoupling domain behavior', () => {
  it('allows seat 1 to start as Moonwatch and seat 2 as Aldermere', () => {
    const state = initialState(mkConfig({
      seats: [
        { kind: 'human', name: 'P1', factionPresetId: 'moonwatch' },
        { kind: 'human', name: 'P2', factionPresetId: 'aldermere' },
        { kind: 'empty', name: '', factionPresetId: 'sunspire' },
        { kind: 'empty', name: '', factionPresetId: 'grimhold' },
      ],
    }));

    expect(state.seats[0].factionId).toBe('f1');
    expect(state.seats[0].factionPresetId).toBe('moonwatch');
    expect(state.seats[1].factionId).toBe('f2');
    expect(state.seats[1].factionPresetId).toBe('aldermere');
  });

  it('does not shift selected presets when empty seats exist between active seats', () => {
    const state = initialState(mkConfig({
      seats: [
        { kind: 'human', name: 'P1', factionPresetId: 'moonwatch' },
        { kind: 'empty', name: '', factionPresetId: 'aldermere' },
        { kind: 'human', name: 'P3', factionPresetId: 'grimhold' },
        { kind: 'empty', name: '', factionPresetId: 'sunspire' },
      ],
    }));

    expect(state.seats).toHaveLength(2);
    expect(state.seats[0]).toMatchObject({ idx: 0, factionId: 'f1', factionPresetId: 'moonwatch' });
    expect(state.seats[1]).toMatchObject({ idx: 2, factionId: 'f2', factionPresetId: 'grimhold' });
  });

  it('initializes faction state from selected preset metadata and deck stays namespaced by runtime faction id', () => {
    const state = initialState(mkConfig({
      seats: [
        { kind: 'human', name: 'P1', factionPresetId: 'sunspire' },
        { kind: 'human', name: 'P2', factionPresetId: 'moonwatch' },
        { kind: 'empty', name: '', factionPresetId: 'aldermere' },
        { kind: 'empty', name: '', factionPresetId: 'grimhold' },
      ],
    }));

    const preset = FACTION_PRESETS.find((p) => p.id === 'sunspire');
    expect(preset).toBeTruthy();
    expect(state.factions.f1.factionPresetId).toBe('sunspire');
    expect(state.factions.f1.name).toBe(preset?.cityName);
    expect(state.factions.f1.color).toBe(preset?.color);
    expect(state.factions.f1.accent).toBe(preset?.accent);
    expect(state.factions.f1.glyph).toBe(preset?.glyph);
    expect(state.factions.f1.pattern).toBe(preset?.pattern);
    expect(state.factions.f1.unitPool).toBe(preset?.unitPool);

    const { deck } = makeStarterDeck('f2', 123);
    expect(deck.every((c) => c.uid.startsWith('f2:'))).toBe(true);
  });

  it('accepts old seat config shape without factionPresetId via deterministic legacy fallback', () => {
    const legacyConfig = {
      ...mkConfig(),
      seats: [
        { kind: 'human', name: 'Legacy 1' },
        { kind: 'empty', name: '' },
        { kind: 'human', name: 'Legacy 3' },
        { kind: 'empty', name: '' },
      ],
    } as unknown as GameConfig;

    const state = initialState(legacyConfig);

    expect(state.seats[0].factionPresetId).toBe('aldermere');
    expect(state.seats[1].factionPresetId).toBe('grimhold');
  });

  it('guards runtime faction id lookup for malformed configs with >4 active seats', () => {
    const seats = activeSeats({
      ...mkConfig(),
      seats: [
        { kind: 'human', name: 'P1', factionPresetId: 'aldermere' },
        { kind: 'human', name: 'P2', factionPresetId: 'grimhold' },
        { kind: 'human', name: 'P3', factionPresetId: 'sunspire' },
        { kind: 'human', name: 'P4', factionPresetId: 'moonwatch' },
        { kind: 'human', name: 'P5', factionPresetId: 'aldermere' },
      ],
    });

    expect(seats[4].factionId).toBe('f1');
    expect(seats[4].factionPresetId).toBe('aldermere');
  });
});
