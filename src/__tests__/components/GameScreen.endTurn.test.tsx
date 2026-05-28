// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GameScreen } from '../../ui/GameScreen';
import { initialState } from '../../game/state';
import { hexKey, neighbors } from '../../game/hex';
import { cloneGameState } from '../../game/clone';
import { mkConfig } from '../helpers';

const PREFS_KEY = 'helmets-clash:prefs:v1';

// Global "warn on end turn" pref ON, tutorial dismissed (so the overlay
// doesn't intercept clicks). This pref is the master switch the per-game
// suppression layers under.
const setPrefsWarnOn = () => {
  window.localStorage.setItem(PREFS_KEY, JSON.stringify({
    aiSpeed: 'instant',
    theme: 'default',
    tutorial: 'dismissed',
    confirmEndTurnWithActions: true,
  }));
};

// 1 human + 1 AI. Strip enemy units so the AI can't attack — the human stays
// alive and active across end-turn cycles, making the flow deterministic. Keep
// exactly one viewer unit (moved = 0) with grass neighbors so it always has a
// legal move and the warning predicate fires.
const prepareUnmovedHumanState = (seed: number) => {
  const s = cloneGameState(initialState(mkConfig({
    seed,
    seats: [
      { kind: 'human', name: 'P1' },
      { kind: 'ai', name: 'AI' },
      { kind: 'empty', name: '' },
      { kind: 'empty', name: '' },
    ],
  })));
  const viewerFactionId = s.seats[0].factionId;
  const unit = s.units.find((u) => u.faction === viewerFactionId)!;
  unit.moved = 0;
  s.units = [unit];
  neighbors(unit.q, unit.r).forEach((n) => {
    s.map[hexKey(n.q, n.r)] = { q: n.q, r: n.r, type: 'grass' };
  });
  return s;
};

const renderGame = (state: ReturnType<typeof prepareUnmovedHumanState>, key: string) =>
  render(<GameScreen key={key} config={state.config} initialState={state} onExit={() => {}} />);

const clickEndTurn = () => fireEvent.click(screen.getByRole('button', { name: /end turn \(e\)/i }));
const warningHeading = () => screen.queryByRole('heading', { name: /end turn\?/i });

describe('GameScreen end-turn warning + per-game suppression', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setPrefsWarnOn();
  });
  afterEach(cleanup);

  it('shows the warning when the viewer has an unmoved unit with a legal move', () => {
    renderGame(prepareUnmovedHumanState(7001), 'game-a');
    expect(warningHeading()).toBeNull();
    clickEndTurn();
    expect(warningHeading()).toBeInTheDocument();
    expect(screen.getByText(/units that haven't moved/i)).toBeInTheDocument();
  });

  it('suppresses the warning for the rest of the game once confirmed with the box checked', () => {
    renderGame(prepareUnmovedHumanState(7002), 'game-a');

    clickEndTurn();
    expect(warningHeading()).toBeInTheDocument();

    // Tick "Don't warn me again this game", then confirm.
    fireEvent.click(screen.getByRole('checkbox', { name: /don't warn me again this game/i }));
    fireEvent.click(screen.getByRole('button', { name: /end turn anyway/i }));
    expect(warningHeading()).toBeNull();

    // Back on the human's turn (AI has no units): ending again must NOT warn.
    clickEndTurn();
    expect(warningHeading()).toBeNull();
  });

  it('does NOT suppress when "End turn anyway" is confirmed with the box unchecked', () => {
    renderGame(prepareUnmovedHumanState(7003), 'game-a');

    clickEndTurn();
    expect(warningHeading()).toBeInTheDocument();
    // Confirm without ticking the box.
    fireEvent.click(screen.getByRole('button', { name: /end turn anyway/i }));
    expect(warningHeading()).toBeNull();

    // Warning should reappear on the next turn since nothing was suppressed.
    clickEndTurn();
    expect(warningHeading()).toBeInTheDocument();
  });

  it('resets suppression when a new game starts (component remount)', () => {
    const { rerender } = renderGame(prepareUnmovedHumanState(7004), 'game-a');

    clickEndTurn();
    fireEvent.click(screen.getByRole('checkbox', { name: /don't warn me again this game/i }));
    fireEvent.click(screen.getByRole('button', { name: /end turn anyway/i }));
    clickEndTurn();
    expect(warningHeading()).toBeNull(); // suppressed in game A

    // New game = GameScreen remounts under a fresh key (App.tsx uses gameKey).
    const gameB = prepareUnmovedHumanState(7005);
    rerender(<GameScreen key="game-b" config={gameB.config} initialState={gameB} onExit={() => {}} />);

    clickEndTurn();
    expect(warningHeading()).toBeInTheDocument(); // suppression did not carry over
  });
});
