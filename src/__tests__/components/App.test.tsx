// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GameConfig, GameState } from '../../game/types';
import App from '../../App';

const mockNewGameScreen = vi.fn();
const mockGameScreen = vi.fn();
const mockHasSave = vi.fn();
const mockLoadGame = vi.fn();
const mockClearSave = vi.fn();

vi.mock('../../ui/NewGameScreen', () => ({
  NewGameScreen: (props: unknown) => mockNewGameScreen(props),
}));

vi.mock('../../ui/GameScreen', () => ({
  GameScreen: (props: unknown) => mockGameScreen(props),
}));

vi.mock('../../game/persist', () => ({
  hasSave: () => mockHasSave(),
  loadGame: () => mockLoadGame(),
  clearSave: () => mockClearSave(),
}));

const baseConfig: GameConfig = {
  mapSize: 'medium',
  mapType: 'continents',
  seats: [
    { kind: 'human', name: 'Player 1', factionPresetId: 'aldermere' },
    { kind: 'ai', name: 'AI Grimhold', factionPresetId: 'grimhold' },
    { kind: 'empty', name: '', factionPresetId: 'sunspire' },
    { kind: 'empty', name: '', factionPresetId: 'moonwatch' },
  ],
  seed: 123,
};

const makeResumeState = (): GameState => ({
  turn: 3,
  activeSeatIdx: 0,
  seed: 456,
  cardRng: 456,
  config: baseConfig,
  map: {},
  mapCols: 8,
  mapRows: 8,
  seats: [
    { idx: 0, factionId: 'f1', factionPresetId: 'aldermere', kind: 'human', name: 'Player 1' },
    { idx: 1, factionId: 'f2', factionPresetId: 'grimhold', kind: 'ai', name: 'AI Grimhold' },
  ],
  cities: [],
  units: [],
  factions: {
    f1: {
      id: 'f1', factionPresetId: 'aldermere', kind: 'human', name: 'Player 1', displayName: 'Player 1', color: '#000', accent: '#fff', glyph: 'A', pattern: 'solid', unitPool: 'living',
      gold: 0, food: 0, deck: [], hand: [], discard: [], orders: 0, buildings: new Set(), explored: new Set(), totalKills: 0, totalCardsPlayed: 0, ambushActive: false,
    },
    f2: {
      id: 'f2', factionPresetId: 'grimhold', kind: 'ai', name: 'AI Grimhold', displayName: 'AI Grimhold', color: '#111', accent: '#eee', glyph: 'G', pattern: 'solid', unitPool: 'living',
      gold: 0, food: 0, deck: [], hand: [], discard: [], orders: 0, buildings: new Set(), explored: new Set(), totalKills: 0, totalCardsPlayed: 0, ambushActive: false,
    },
    f3: {
      id: 'f3', factionPresetId: 'sunspire', kind: 'empty', name: '', displayName: '', color: '#222', accent: '#ddd', glyph: 'S', pattern: 'solid', unitPool: 'living',
      gold: 0, food: 0, deck: [], hand: [], discard: [], orders: 0, buildings: new Set(), explored: new Set(), totalKills: 0, totalCardsPlayed: 0, ambushActive: false,
    },
    f4: {
      id: 'f4', factionPresetId: 'moonwatch', kind: 'empty', name: '', displayName: '', color: '#333', accent: '#ccc', glyph: 'M', pattern: 'solid', unitPool: 'living',
      gold: 0, food: 0, deck: [], hand: [], discard: [], orders: 0, buildings: new Set(), explored: new Set(), totalKills: 0, totalCardsPlayed: 0, ambushActive: false,
    },
  },
  status: 'playing',
  winner: null,
  log: [],
  targeting: null,
  selectedUnitId: null,
  undoBuffer: null,
  pendingPassSeatIdx: null,
});

beforeEach(() => {
  localStorage.clear();
  mockNewGameScreen.mockImplementation((props: { canResume?: boolean; onResume?: () => void; onDiscardSave?: () => void; onStart?: (config: GameConfig) => void }) => (
    <div>
      <div>setup-screen</div>
      <div>can-resume:{String(!!props.canResume)}</div>
      <button type="button" onClick={props.onResume}>resume</button>
      <button type="button" onClick={props.onDiscardSave}>discard</button>
      <button type="button" onClick={() => props.onStart?.(baseConfig)}>start</button>
    </div>
  ));
  mockGameScreen.mockImplementation((props: { onExit: (mode: 'menu' | 'replay') => void; config: GameConfig; initialState?: GameState }) => (
    <div>
      <div>game-screen</div>
      <div>cfg-map-size:{props.config.mapSize}</div>
      <div>seed:{String(props.config.seed)}</div>
      <div>has-initial:{String(!!props.initialState)}</div>
      <button type="button" onClick={() => props.onExit('menu')}>to-menu</button>
      <button type="button" onClick={() => props.onExit('replay')}>replay</button>
    </div>
  ));
  mockHasSave.mockReset();
  mockLoadGame.mockReset();
  mockClearSave.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('App', () => {
  it('startup with valid save shows setup and resume/discard affordances', () => {
    mockHasSave.mockReturnValue(true);
    mockLoadGame.mockReturnValue(makeResumeState());

    render(<App />);

    expect(screen.getByText('setup-screen')).toBeInTheDocument();
    expect(screen.getByText('can-resume:true')).toBeInTheDocument();
    expect(screen.queryByText('game-screen')).not.toBeInTheDocument();
  });

  it('resume enters game with resumed initial state', async () => {
    const user = userEvent.setup();
    const resumed = makeResumeState();
    mockHasSave.mockReturnValue(true);
    mockLoadGame.mockReturnValue(resumed);

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'resume' }));

    expect(screen.getByText('game-screen')).toBeInTheDocument();
    expect(screen.getByText('has-initial:true')).toBeInTheDocument();
  });

  it('discard clears save and remains in setup mode', async () => {
    const user = userEvent.setup();
    mockHasSave.mockReturnValue(true);
    mockLoadGame.mockReturnValue(makeResumeState());

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'discard' }));

    expect(mockClearSave).toHaveBeenCalledTimes(1);
    expect(screen.getByText('setup-screen')).toBeInTheDocument();
    expect(screen.getByText('can-resume:false')).toBeInTheDocument();
  });

  it('malformed save falls back to setup safely', () => {
    mockHasSave.mockReturnValue(true);
    mockLoadGame.mockReturnValue(null);

    render(<App />);

    expect(screen.getByText('setup-screen')).toBeInTheDocument();
    expect(screen.getByText('can-resume:false')).toBeInTheDocument();
  });

  it('replay after resumed game starts fresh game with same setup fields', async () => {
    const user = userEvent.setup();
    const resumed = makeResumeState();
    mockHasSave.mockReturnValue(true);
    mockLoadGame.mockReturnValue(resumed);

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.001234567);

    render(<App />);
    await user.click(screen.getByRole('button', { name: 'resume' }));

    expect(screen.getByText('cfg-map-size:medium')).toBeInTheDocument();
    expect(screen.getByText('seed:123')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'replay' }));

    expect(screen.getByText('game-screen')).toBeInTheDocument();
    expect(screen.getByText('cfg-map-size:medium')).toBeInTheDocument();
    expect(screen.getByText('has-initial:false')).toBeInTheDocument();
    expect(screen.getByText('seed:1234567')).toBeInTheDocument();
    expect(mockClearSave).toHaveBeenCalled();

    randomSpy.mockRestore();
  });
});
