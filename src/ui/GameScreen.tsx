import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { Coins, Wheat, Sparkles, Skull, Crown, HelpCircle, Hammer, RotateCcw, Undo2, Settings, BookOpen } from 'lucide-react';
import type {
  BuildingId, Card, FactionId, GameConfig, GameState,
  Hex, HexKey, UnitType,
} from '../game/types';
import { HEX_NAV, hexKey } from '../game/hex';
import { computeMoveRange, computeAttackTargets, factionHasUnmovedUnit } from '../game/logic';
import { initialState } from '../game/state';
import { reducer } from '../game/reducer';
import { debouncedSaveGame, clearSave, flushPendingSave } from '../game/persist';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { useUIPrefs } from '../hooks/useUIPrefs';
import { HexBoard } from './HexBoard';
import { InfoPanel } from './InfoPanel';
import { HandBar } from './HandBar';
import { CityModal } from './CityModal';
import { HelpModal } from './HelpModal';
import { PassDeviceModal } from './PassDeviceModal';
import { EndScreen } from './EndScreen';
import { SettingsModal } from './SettingsModal';
import { TutorialOverlay } from './TutorialOverlay';
import { TurnBanner } from './TurnBanner';
import { BUILDINGS } from '../game/constants';

type GameScreenProps = {
  config: GameConfig;
  onExit: (mode: 'menu' | 'replay') => void;
  // When present, GameScreen uses this snapshot instead of generating a
  // fresh game. Used by the App-level localStorage resume flow.
  initialState?: GameState;
};

// The orchestrating game screen. Owns: state, selection cursor, turn loop,
// pass-device gate, AI advancement, victory.
export function GameScreen({ config, onExit, initialState: resumed }: GameScreenProps) {
  const reducedMotion = useReducedMotion();
  // Canonical game state lives behind useReducer now. Every transition is
  // represented by a tagged action dispatched through the reducer; see
  // src/game/reducer.ts for the action union.
  const [state, dispatch] = useReducer(reducer, resumed ?? initialState(config));
  const [prefs, setPrefs] = useUIPrefs();
  // Selection lives on GameState (state.selectedUnitId) so it's captured
  // by the autosave and part of the reducer's pure contract. These
  // aliases keep the rendering / guard code readable.
  const selectedUnit = state.selectedUnitId;
  const setSelectedUnit = (unitId: number | null) => dispatch({ type: 'SELECT_UNIT', unitId });
  const [hoveredHex, setHoveredHex] = useState<HexKey | null>(null);
  const [recentlyDamaged, setRecentlyDamaged] = useState<Record<string, number>>({});
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTutorial, setShowTutorial] = useState(() => prefs.tutorial === 'unseen');
  const [openCityId, setOpenCityId] = useState<number | null>(null);
  // End-Turn confirmation dialog state. Only engaged when the user's
  // `confirmEndTurnWithActions` pref is on AND the viewer still has an
  // unmoved unit with a legal move.
  const [endTurnConfirm, setEndTurnConfirm] = useState(false);
  // Game-scoped opt-out of the End-Turn warning. Set when the user ticks the
  // modal's "don't warn me again this game" box and confirms. Intentionally
  // local React state, NOT a persisted pref: it resets automatically when a
  // new game starts because App.tsx remounts GameScreen via `key={gameKey}`.
  // The global `confirmEndTurnWithActions` pref stays the master switch.
  const [suppressEndTurnWarning, setSuppressEndTurnWarning] = useState(false);
  // Transient checkbox state inside the modal; committed to
  // `suppressEndTurnWarning` only if the user confirms "End turn anyway".
  const [dontWarnThisGame, setDontWarnThisGame] = useState(false);
  // Board view transform. `zoom` is a multiplier on the current viewBox;
  // `pan` is an offset in SVG units applied to the viewBox origin.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  // The faction whose perspective is currently rendered (fog, hand). Starts
  // as the first human seat, or the first seat overall if no humans. The
  // viewer rotates explicitly on pass-device confirm. `initialState` is
  // contractually required to produce at least one seat (2-seat minimum
  // enforced by NewGameScreen) — if it somehow didn't, this throws at
  // mount rather than letting an `undefined` leak through.
  const [viewerFactionId, setViewerFactionId] = useState<FactionId>(() => {
    const firstHuman = state.seats.find((s) => state.factions[s.factionId]?.kind === 'human');
    const fallback = state.seats[0];
    if (!firstHuman && !fallback) {
      throw new Error('initialState produced no seats — game cannot render');
    }
    return (firstHuman ?? fallback).factionId;
  });

  // Keyboard cursor on the hex grid. Initialized to the active viewer's
  // first city if they have one; otherwise the first explored tile on the map.
  const [cursor, setCursor] = useState<Hex>(() => {
    const c = state.cities.find((x) => x.faction === viewerFactionId);
    return c ? { q: c.q, r: c.r } : { q: 0, r: 0 };
  });

  const announcerRef = useRef<HTMLDivElement | null>(null);
  const boardRef = useRef<SVGSVGElement | null>(null);

  // Focus the board on mount for keyboard users. `initialState` now
  // pre-applies start-of-turn housekeeping for seat 0 so no mount-effect
  // dispatch is needed to prime orders / card draw / fog reveal.
  useEffect(() => {
    boardRef.current?.focus?.();
  }, []);

  const activeSeat = state.seats.find((s) => s.idx === state.activeSeatIdx);
  const activeFaction = activeSeat ? state.factions[activeSeat.factionId] : null;
  const isViewerActive = viewerFactionId === activeSeat?.factionId;
  const ended = state.status === 'ended';

  // Move/attack overlays only when the selected unit belongs to the viewer
  // AND the viewer is the active seat. Depends on the full `state` (rather
  // than narrowed slices) because the React Compiler's exhaustive-deps
  // rule rejects field-level deps when the callback passes `state` through
  // to a helper. Recomputing on any state change is acceptable — the
  // helpers are O(hex count × units) and hex counts stay small.
  const moveRange = useMemo(() => {
    if (!selectedUnit || !isViewerActive) return new Map();
    const u = state.units.find((x) => x.id === selectedUnit);
    if (!u || u.faction !== viewerFactionId) return new Map();
    return computeMoveRange(u, state);
  }, [selectedUnit, state, viewerFactionId, isViewerActive]);

  const attackTargets = useMemo(() => {
    if (!selectedUnit || !isViewerActive) return [];
    const u = state.units.find((x) => x.id === selectedUnit);
    if (!u || u.faction !== viewerFactionId || u.acted) return [];
    return computeAttackTargets(u, state);
  }, [selectedUnit, state, viewerFactionId, isViewerActive]);

  const flashDamage = (id: string | number) => {
    if (reducedMotion) return;
    setRecentlyDamaged((d) => ({ ...d, [id]: Date.now() }));
    setTimeout(() => {
      setRecentlyDamaged((d) => { const n = { ...d }; delete n[id]; return n; });
    }, 600);
  };

  // -- Hex activation (click or Enter on cursor) --
  const handleHexActivate = (q: number, r: number) => {
    if (ended || !isViewerActive || state.pendingPassSeatIdx !== null) return;

    if (state.targeting) {
      dispatch({
        type: 'PLAY_CARD_TARGETED',
        factionId: viewerFactionId,
        card: state.targeting.card,
        q, r,
      });
      return;
    }

    const unitAt = state.units.find((u) => u.q === q && u.r === r);
    const cityAt = state.cities.find((c) => c.q === q && c.r === r);
    const friendlyUnitAt = unitAt?.faction === viewerFactionId ? unitAt : null;
    const friendlyCityAt = cityAt?.faction === viewerFactionId ? cityAt : null;

    if (selectedUnit) {
      const unit = state.units.find((u) => u.id === selectedUnit);
      if (!unit) { setSelectedUnit(null); return; }
      if (unitAt && unitAt.faction === viewerFactionId && unitAt.id !== selectedUnit) {
        setSelectedUnit(unitAt.id);
        return;
      }
      const atkTarget = attackTargets.find((t) => t.target.q === q && t.target.r === r);
      if (atkTarget && !unit.acted) {
        const damageKey = atkTarget.type === 'city'
          ? `city-${atkTarget.target.name}`
          : atkTarget.target.id;
        flashDamage(damageKey);
        // Reducer's ATTACK case clears selection as part of the same
        // transition, so no explicit SELECT_UNIT(null) is needed here.
        dispatch({ type: 'ATTACK', attackerId: unit.id, target: atkTarget });
        return;
      }
      const moveCost = moveRange.get(hexKey(q, r));
      if (moveCost !== undefined && !unitAt && (!cityAt || cityAt.faction === viewerFactionId)) {
        dispatch({ type: 'MOVE_UNIT', unitId: unit.id, q, r, moveCost });
        return;
      }
      // If a friendly unit is standing in the viewer's city, allow a
      // second activation on that tile to open city management instead of
      // forcing a deselect-only dead end.
      if (cityAt && cityAt.faction === viewerFactionId && unitAt?.id === selectedUnit) {
        setOpenCityId(cityAt.id);
        return;
      }
      setSelectedUnit(null);
      return;
    }

    if (friendlyUnitAt) {
      setSelectedUnit(friendlyUnitAt.id);
      return;
    }
    if (friendlyCityAt) {
      setOpenCityId(friendlyCityAt.id);
    }
  };

  // -- Card play handler --
  const playCard = (card: Card) => {
    if (!isViewerActive || ended || state.targeting || state.pendingPassSeatIdx !== null) return;
    if (state.factions[viewerFactionId].orders < card.cost) return;
    if (card.target !== 'none') {
      dispatch({ type: 'BEGIN_TARGETING', card });
      return;
    }
    dispatch({ type: 'PLAY_CARD_UNTARGETED', factionId: viewerFactionId, card });
  };

  // -- Recruit / build --
  const recruitUnit = (type: UnitType) => {
    if (!isViewerActive) return;
    dispatch({ type: 'RECRUIT', factionId: viewerFactionId, unitType: type });
  };

  const constructBuilding = (id: BuildingId) => {
    if (!isViewerActive) return;
    dispatch({ type: 'BUILD', factionId: viewerFactionId, building: id });
  };

  // -- End turn: reducer handles the AI loop + pass-device gate atomically,
  // and clears selection as part of the same transition. Optionally prompts
  // first when the user has `confirmEndTurnWithActions` set, hasn't muted the
  // warning for this game, and the viewer still has an unmoved unit that could
  // legally move. The "unmoved unit with a legal move" check lives in the rule
  // engine (factionHasUnmovedUnit) so it stays consistent with movement rules.
  const doEndTurn = () => {
    setOpenCityId(null);
    dispatch({ type: 'END_TURN', viewerFactionId });
  };
  const endTurn = () => {
    if (!isViewerActive || ended) return;
    if (prefs.confirmEndTurnWithActions && !suppressEndTurnWarning
        && factionHasUnmovedUnit(state, viewerFactionId)) {
      setEndTurnConfirm(true);
      return;
    }
    doEndTurn();
  };
  // Dismiss the modal without ending the turn. Resets only the transient
  // checkbox; any already-committed per-game suppression stays.
  const dismissEndTurnConfirm = () => {
    setEndTurnConfirm(false);
    setDontWarnThisGame(false);
  };
  // "End turn anyway": commit the per-game suppression if the box is ticked,
  // then proceed. Reads the current `dontWarnThisGame` before the state reset.
  const confirmEndTurnAnyway = () => {
    if (dontWarnThisGame) setSuppressEndTurnWarning(true);
    dismissEndTurnConfirm();
    doEndTurn();
  };

  const undoMove = () => {
    if (!isViewerActive || ended) return;
    if (!state.undoBuffer) return;
    dispatch({ type: 'UNDO_MOVE' });
  };

  // Sync the tutorial pref with local state so dismissing writes the flag.
  const dismissTutorial = () => {
    setShowTutorial(false);
    setPrefs({ tutorial: 'dismissed' });
  };

  const confirmPass = () => {
    const pending = state.pendingPassSeatIdx;
    if (pending === null) return;
    const seat = state.seats.find((x) => x.idx === pending);
    if (!seat) return;
    // Game state transition is a single CONFIRM_PASS action. Side effects
    // (viewer switch, cursor reset, focus) live outside the reducer since
    // they're UI-only concerns.
    dispatch({ type: 'CONFIRM_PASS' });
    setOpenCityId(null);
    setViewerFactionId(seat.factionId);
    const c = state.cities.find((x) => x.faction === seat.factionId);
    if (c) setCursor({ q: c.q, r: c.r });
    setTimeout(() => boardRef.current?.focus?.(), 0);
  };

  const cancelTargeting = () => dispatch({ type: 'CANCEL_TARGETING' });

  // Latest-handler refs so the keyboard effect (mounted once) always calls
  // the current closures without re-binding the listener every render.
  // Selection now lives on GameState, so the keyboard effect can read it
  // directly from stateRef.current.selectedUnitId; no separate selectedRef
  // is needed. Ditto for pendingPassSeatIdx.
  const endTurnRef = useRef<() => void>(endTurn);
  const handleHexActivateRef = useRef<(q: number, r: number) => void>(handleHexActivate);
  const stateRef = useRef<GameState>(state);
  const cursorRef = useRef<Hex>(cursor);
  const activeRef = useRef<boolean>(isViewerActive);
  const endedRef = useRef<boolean>(ended);
  const cityRef = useRef<boolean>(openCityId !== null);
  useEffect(() => {
    endTurnRef.current = endTurn;
    handleHexActivateRef.current = handleHexActivate;
    stateRef.current = state;
    cursorRef.current = cursor;
    activeRef.current = isViewerActive;
    endedRef.current = ended;
    cityRef.current = openCityId !== null;
  });

  // -- Keyboard handling on the board (and globally for shortcuts) --
  // The handler is mounted once and reads the latest closures via refs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (stateRef.current.pendingPassSeatIdx !== null) return;

      if ((e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey) {
        if (activeRef.current && !endedRef.current) { e.preventDefault(); endTurnRef.current(); return; }
      }
      // Ctrl/Cmd + Z → undo last move. Only while a valid undo exists.
      if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
        if (activeRef.current && !endedRef.current && stateRef.current.undoBuffer) {
          e.preventDefault();
          dispatch({ type: 'UNDO_MOVE' });
          return;
        }
      }
      if (e.key === '?') { e.preventDefault(); setShowHelp(true); return; }
      if (e.key === 'Escape') {
        if (stateRef.current.targeting) { dispatch({ type: 'CANCEL_TARGETING' }); return; }
        if (stateRef.current.selectedUnitId !== null) { dispatch({ type: 'SELECT_UNIT', unitId: null }); return; }
        if (cityRef.current) { setOpenCityId(null); return; }
      }
      if (document.activeElement === boardRef.current) {
        const dir = HEX_NAV[e.key];
        if (dir) {
          e.preventDefault();
          setCursor((c) => {
            const nq = c.q + dir.q, nr = c.r + dir.r;
            if (stateRef.current.map[hexKey(nq, nr)]) return { q: nq, r: nr };
            return c;
          });
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const c = cursorRef.current;
          handleHexActivateRef.current(c.q, c.r);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // -- Aria-live announcements for log changes --
  const lastLogIdxRef = useRef(state.log.length);
  useEffect(() => {
    if (state.log.length === lastLogIdxRef.current) return;
    const newest = state.log[state.log.length - 1];
    if (newest && announcerRef.current) {
      announcerRef.current.textContent = newest.text;
    }
    lastLogIdxRef.current = state.log.length;
  }, [state.log]);

  // -- localStorage autosave. Debounced at 200ms to avoid writing the full
  // ~100KB GameState blob on every pointer event during unit selection or
  // cursor movement. On game-end we drop the save entirely. On unmount we
  // flush any pending write so a close-tab during the debounce window
  // doesn't lose the last meaningful action.
  useEffect(() => {
    if (state.status === 'ended') {
      clearSave();
      return;
    }
    debouncedSaveGame(state);
  }, [state]);

  useEffect(() => {
    return () => { flushPendingSave(); };
  }, []);

  // Render-time computed values
  const selectedUnitObj = state.units.find((u) => u.id === selectedUnit);
  const viewer = state.factions[viewerFactionId];
  const openCity = openCityId !== null
    ? state.cities.find((c) => c.id === openCityId && c.faction === viewerFactionId)
    : undefined;
  const selectedUnitCity = selectedUnitObj
    ? state.cities.find((c) => c.q === selectedUnitObj.q && c.r === selectedUnitObj.r)
    : undefined;
  const hasSelectedFriendlyUnitAndFriendlyCity = !!(selectedUnitObj && selectedUnitObj.faction === viewerFactionId && selectedUnitCity?.faction === viewerFactionId);
  const canManageOpenCity = !!openCity && openCity.faction === viewerFactionId && isViewerActive;
  const maxOrders = 3 + (viewer?.buildings.has('war_council') ? 1 : 0);
  const passSeat = state.pendingPassSeatIdx !== null ? state.seats.find((s) => s.idx === state.pendingPassSeatIdx) : null;
  const passFaction = passSeat ? state.factions[passSeat.factionId] : null;

  return (
    <div className="w-full min-h-screen bg-gradient-to-br from-amber-50 to-stone-100 text-stone-800" style={{ fontFamily: 'ui-serif, Georgia, serif' }}>
      <div className="max-w-7xl mx-auto p-3">
        <header className="flex items-center justify-between mb-3 px-2">
          <div className="flex items-center gap-3">
            <Crown className="text-amber-700" size={28} aria-hidden="true" />
            <div>
              <h1 className="text-2xl font-bold tracking-wide text-stone-900">Helmets Clash</h1>
              <div className="text-xs text-stone-700 -mt-1">Turn {state.turn} · {activeFaction?.displayName || 'Unknown'}{!isViewerActive && ' (waiting)'}</div>
            </div>
          </div>
          <nav aria-label="Main controls" className="flex items-center gap-4 bg-white/80 backdrop-blur rounded-lg px-4 py-2 shadow-sm border border-stone-300">
            <Stat icon={<Coins size={18} className="text-amber-700" aria-hidden="true" />} label="Gold" value={viewer?.gold ?? 0} />
            <Stat icon={<Wheat size={18} className="text-yellow-800" aria-hidden="true" />} label="Food" value={viewer?.food ?? 0} />
            <Stat icon={<Sparkles size={18} className="text-indigo-700" aria-hidden="true" />} label="Orders" value={`${viewer?.orders ?? 0}/${maxOrders}`} />
            <div className="h-8 w-px bg-stone-300" aria-hidden="true" />
            <button
              type="button"
              onClick={endTurn}
              disabled={!isViewerActive || ended}
              aria-keyshortcuts="E"
              className="bg-amber-700 hover:bg-amber-800 disabled:bg-stone-300 disabled:text-stone-600 text-white font-semibold px-4 py-2 rounded shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 transition"
            >
              End Turn (E)
            </button>
            <button
              type="button"
              onClick={undoMove}
              disabled={!isViewerActive || ended || !state.undoBuffer}
              aria-label="Undo last move"
              aria-keyshortcuts="Control+Z"
              className="text-stone-700 hover:text-stone-900 disabled:text-stone-400 p-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <Undo2 size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setShowTutorial(true)}
              aria-label="Open tutorial"
              className="text-stone-700 hover:text-stone-900 p-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <BookOpen size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setShowHelp(true)}
              aria-label="Open help"
              aria-keyshortcuts="?"
              className="text-stone-700 hover:text-stone-900 p-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <HelpCircle size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              aria-label="Open settings"
              className="text-stone-700 hover:text-stone-900 p-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <Settings size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onExit('menu')}
              aria-label="Exit to main menu"
              className="text-stone-700 hover:text-stone-900 p-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <RotateCcw size={20} aria-hidden="true" />
            </button>
          </nav>
        </header>

        {/* Polite live region for log updates */}
        <div ref={announcerRef} role="status" aria-live="polite" className="sr-only" />

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-3">
          <div className="relative bg-gradient-to-b from-sky-100 to-amber-50 rounded-lg border-2 border-stone-300 shadow-inner overflow-hidden">
            {state.targeting && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 bg-indigo-900 text-white px-4 py-2 rounded shadow flex items-center gap-3" role="status">
                <span className="text-sm">Select target for <b>{state.targeting.card.name}</b></span>
                <button type="button" onClick={cancelTargeting} className="hover:text-red-200 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">Cancel</button>
              </div>
            )}
            {!isViewerActive && !ended && (
              <div className="absolute top-2 right-2 z-20 bg-stone-800/95 text-white px-3 py-1.5 rounded text-sm flex items-center gap-2" role="status">
                <Skull size={16} className={reducedMotion ? '' : 'animate-pulse'} aria-hidden="true" />
                <span>{activeFaction?.displayName} is plotting…</span>
              </div>
            )}
            <HexBoard
              state={state}
              viewerFactionId={viewerFactionId}
              selectedUnit={selectedUnit}
              hoveredHex={hoveredHex}
              setHoveredHex={setHoveredHex}
              cursor={cursor}
              setCursor={setCursor}
              onHexActivate={handleHexActivate}
              moveRange={moveRange}
              attackTargets={attackTargets}
              recentlyDamaged={recentlyDamaged}
              reducedMotion={reducedMotion}
              boardRef={boardRef}
              zoom={zoom}
              pan={pan}
            />
            {/* Zoom controls — absolute-positioned over the top-right of
                the board. Keyboard-accessible via tab + Enter. */}
            <div className="absolute bottom-2 right-2 z-10 flex flex-col gap-1 bg-white/80 backdrop-blur rounded border border-stone-300 p-1 shadow">
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
                className="px-2 py-1 text-sm font-bold text-stone-800 hover:bg-amber-50 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >+</button>
              <button
                type="button"
                aria-label="Reset zoom and pan"
                onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
                className="px-2 py-0.5 text-[10px] text-stone-700 hover:bg-amber-50 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >1:1</button>
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                className="px-2 py-1 text-sm font-bold text-stone-800 hover:bg-amber-50 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >−</button>
            </div>
          </div>

          <aside aria-label="Side panel" className="flex flex-col gap-3">
            <InfoPanel selectedUnit={selectedUnitObj} state={state} hoveredKey={hoveredHex} />
            {hasSelectedFriendlyUnitAndFriendlyCity && selectedUnitCity && (
              <section aria-labelledby="stacked-city-heading" className="bg-white/85 backdrop-blur rounded-lg border border-stone-300 p-3 shadow-sm">
                <h2 id="stacked-city-heading" className="text-xs uppercase tracking-wider text-stone-700 mb-2 font-semibold">
                  Tile actions
                </h2>
                <p className="text-xs text-stone-700 mb-2">
                  This tile has both your selected unit and your city.
                </p>
                <button
                  type="button"
                  onClick={() => setOpenCityId(selectedUnitCity.id)}
                  className="w-full bg-amber-700 hover:bg-amber-800 text-white text-sm font-semibold px-3 py-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
                  aria-label={`Open city ${selectedUnitCity.name} management (unit and city share this tile)`}
                >
                  Open city
                </button>
              </section>
            )}

            <section aria-labelledby="structures-heading" className="bg-white/85 backdrop-blur rounded-lg border border-stone-300 p-3 shadow-sm">
              <h2 id="structures-heading" className="text-xs uppercase tracking-wider text-stone-700 mb-2 flex items-center gap-1 font-semibold">
                <Hammer size={14} aria-hidden="true" /> Structures
              </h2>
              {viewer && viewer.buildings.size === 0 ? (
                <div className="text-xs text-stone-700 italic">None yet. Activate your city to build.</div>
              ) : (
                <ul className="space-y-1" role="list">
                  {viewer && Array.from(viewer.buildings).map((id) => (
                    <li key={id} className="flex items-center gap-2 text-xs">
                      <span aria-hidden="true" className="text-base">{BUILDINGS[id].icon}</span>
                      <span className="font-semibold">{BUILDINGS[id].name}</span>
                      <span className="text-stone-700 text-[10px]">· {BUILDINGS[id].desc}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="chronicle-heading" className="bg-white/85 backdrop-blur rounded-lg border border-stone-300 p-3 shadow-sm flex-1 min-h-[150px]">
              <h2 id="chronicle-heading" className="text-xs uppercase tracking-wider text-stone-700 mb-2 font-semibold">Chronicle</h2>
              <ol className="text-xs space-y-1 max-h-40 overflow-y-auto">
                {[...state.log].reverse().map((entry, i) => {
                  const base = entry.faction === 'system' ? 'text-stone-700 italic' : 'text-stone-900';
                  // Entries carrying a hex coord render as buttons that
                  // center the keyboard cursor on that hex — turns the log
                  // into a combat-navigation tool.
                  if (entry.hex) {
                    return (
                      <li key={i}>
                        <button
                          type="button"
                          onClick={() => { if (entry.hex) setCursor(entry.hex); boardRef.current?.focus?.(); }}
                          className={`text-left w-full hover:bg-stone-100 rounded px-1 py-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${base}`}
                          title="Jump to this hex"
                        >
                          <span className="text-stone-500">T{entry.turn}:</span> {entry.text}
                        </button>
                      </li>
                    );
                  }
                  return (
                    <li key={i} className={`px-1 ${base}`}>
                      <span className="text-stone-500">T{entry.turn}:</span> {entry.text}
                    </li>
                  );
                })}
              </ol>
            </section>
          </aside>
        </div>

        <HandBar
          faction={viewer}
          canPlay={!state.targeting && !ended}
          isViewerActive={isViewerActive}
          onPlayCard={playCard}
        />

        {/* Status footer */}
        <footer className="mt-3 text-xs text-stone-700 text-center">
          Map: {state.config.resolvedMapType || state.config.mapType} · {state.mapCols}×{state.mapRows} · Seed {state.config.seed} · {Object.values(state.factions).length} factions
        </footer>
      </div>

      <CityModal
        open={!!openCity}
        onClose={() => setOpenCityId(null)}
        city={openCity}
        faction={openCity ? state.factions[openCity.faction] : undefined}
        canAct={canManageOpenCity}
        onRecruit={recruitUnit}
        onBuild={constructBuilding}
      />

      <HelpModal open={showHelp} onClose={() => setShowHelp(false)} />

      <PassDeviceModal
        open={state.pendingPassSeatIdx !== null}
        seatName={passSeat?.name || passFaction?.displayName || ''}
        factionName={passFaction?.name || ''}
        factionGlyph={passFaction?.glyph || ''}
        factionColor={passFaction?.color || '#8b6b2a'}
        onReady={confirmPass}
      />

      <EndScreen
        open={ended}
        winner={state.winner}
        faction={state.winner ? state.factions[state.winner] : null}
        turn={state.turn}
        state={state}
        onNewGame={() => onExit('replay')}
        onMainMenu={() => onExit('menu')}
      />

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        prefs={prefs}
        setPrefs={setPrefs}
      />

      <TutorialOverlay open={showTutorial} onDismiss={dismissTutorial} />

      {/* End-Turn confirmation. Only renders when requested; wraps Dialog
          via inline JSX to keep the single-use copy co-located. */}
      {endTurnConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="endturn-confirm-title"
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={dismissEndTurnConfirm}
        >
          <div
            className="bg-gradient-to-b from-amber-100 to-amber-50 border-2 border-amber-700 rounded-lg p-5 max-w-sm w-full m-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="endturn-confirm-title" className="text-xl font-bold mb-2">End turn?</h2>
            <p className="text-sm text-stone-800 mb-4">
              You still have units that haven't moved. Are you sure you want to end your turn?
            </p>
            <label className="flex items-start gap-2 mb-4 text-sm text-stone-800 cursor-pointer">
              <input
                type="checkbox"
                checked={dontWarnThisGame}
                onChange={(e) => setDontWarnThisGame(e.target.checked)}
                className="mt-0.5"
              />
              <span>Don't warn me again this game</span>
            </label>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={dismissEndTurnConfirm}
                className="bg-stone-200 hover:bg-stone-300 text-stone-900 font-semibold px-4 py-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                Keep playing
              </button>
              <button
                type="button"
                onClick={confirmEndTurnAnyway}
                autoFocus
                className="bg-amber-700 hover:bg-amber-800 text-white font-semibold px-4 py-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
              >
                End turn anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Turn banner — re-mounts on (turn, activeSeatIdx) so it fires
          on every rotation. Respects prefers-reduced-motion. */}
      {activeSeat && activeFaction && !state.pendingPassSeatIdx && (
        <TurnBanner
          key={`${state.turn}-${state.activeSeatIdx}`}
          turn={state.turn}
          factionName={activeFaction.displayName}
          factionGlyph={activeFaction.glyph}
          factionColor={activeFaction.color}
          reducedMotion={reducedMotion}
        />
      )}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <div className="text-sm">
        <div className="text-xs text-stone-700 leading-none">{label}</div>
        <div className="font-bold leading-tight">{value}</div>
      </div>
    </div>
  );
}

// cloneShallow used to live here for the inline setState updaters. All
// state transitions now go through src/game/reducer.ts, which owns its
// own clone helper. Keep this file focused on UI orchestration.
