"use client";

import { useEffect, useRef, useState } from "react";
import type { Engine, PlayerState } from "@doom-player/doom-core/core";
import { SELFTEST, runSelftest, type SelftestResult } from "@doom-player/doom-core/selftest";
import { PlayerInput } from "@/lib/play/input";
import { GameLoop } from "@/lib/play/loop";
import { loadEngine, type LoadProgress } from "@/lib/play/load";
import s from "./play.module.css";

const WEAPON_SLOT: Record<string, number> = {
  fist: 1, chainsaw: 1, pistol: 2, shotgun: 3, super_shotgun: 3, chaingun: 4, rocket_launcher: 5, plasma_rifle: 6, bfg9000: 7,
};

type Status = { kind: "loading"; p: LoadProgress } | { kind: "ready" } | { kind: "error"; message: string };

export default function Player({ selftest }: { selftest: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<PlayerInput | null>(null);
  const loopRef = useRef<GameLoop | null>(null);
  const stateRef = useRef<PlayerState | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading", p: { phase: "manifest" } });
  const [skill, setSkill] = useState(3);
  const [map, setMap] = useState(1);
  const [alwaysRun, setAlwaysRun] = useState(true);
  const [paused, setPaused] = useState(false);
  const [gameId, setGameId] = useState(0);
  const [stick, setStick] = useState<{ x0: number; y0: number; dx: number; dy: number } | null>(null);
  const [test, setTest] = useState<SelftestResult | null>(null);

  // Boot (or reboot) the engine whenever the game settings change.
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current!;
    const screen = screenRef.current!;
    const stage = stageRef.current!;
    setStatus({ kind: "loading", p: { phase: "manifest" } });
    (async () => {
      try {
        const opts = selftest ? { skill: SELFTEST.skill, episode: SELFTEST.episode, map: SELFTEST.map } : { skill, episode: 1, map };
        const engine: Engine = await loadEngine(opts, (p) => !cancelled && setStatus({ kind: "loading", p }));
        if (cancelled) return;
        if (selftest) {
          const r = await runSelftest(engine);
          setTest(r);
          new GameLoop({ engine, canvas, nextCmd: () => ({ f: 0, s: 0, t: 0, b: 0, n: 1 }) });
          setStatus({ kind: "ready" });
          return;
        }
        const input = new PlayerInput({
          alwaysRun,
          ownedSlots: () => [...new Set((stateRef.current?.weaponsOwned ?? ["pistol"]).map((w) => WEAPON_SLOT[w] ?? 2))].sort(),
        });
        input.attachDesktop(screen);
        input.attachTouch(stage, (st) => setStick(st ? { ...st } : null));
        const loop = new GameLoop({ engine, canvas, nextCmd: () => input.next(), onState: (st) => (stateRef.current = st) });
        inputRef.current = input;
        loopRef.current = loop;
        loop.start();
        setPaused(false);
        setStatus({ kind: "ready" });
      } catch (e) {
        if (!cancelled) setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
      loopRef.current?.stop();
      inputRef.current?.detach();
      loopRef.current = null;
      inputRef.current = null;
    };
    // alwaysRun is applied live below, not by rebooting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill, map, gameId, selftest]);

  useEffect(() => {
    if (inputRef.current) inputRef.current.opts.alwaysRun = alwaysRun;
  }, [alwaysRun]);

  // Pause when the tab is hidden; resume when it comes back (unless paused by hand).
  useEffect(() => {
    const vis = () => {
      const loop = loopRef.current;
      if (!loop) return;
      if (document.hidden) loop.stop();
      else if (!paused) loop.start();
    };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [paused]);

  const togglePause = () => {
    const loop = loopRef.current;
    if (!loop) return;
    if (loop.isRunning) {
      loop.stop();
      setPaused(true);
    } else {
      loop.start();
      setPaused(false);
    }
  };

  const btn = (name: "fire" | "use") => ({
    onTouchStart: (e: React.TouchEvent) => (e.preventDefault(), inputRef.current?.setButton(name, true)),
    onTouchEnd: () => inputRef.current?.setButton(name, false),
    onTouchCancel: () => inputRef.current?.setButton(name, false),
  });

  const pct = status.kind === "loading" && status.p.phase === "wad" && status.p.total ? Math.round(((status.p.loaded ?? 0) / status.p.total) * 100) : null;

  return (
    <main className={s.page}>
      <header className={s.bar}>
        <h1 className={s.title}>
          <a href="/">doom-player</a> <span>/ play</span>
        </h1>
        {!selftest && (
          <div className={s.settings}>
            <label>
              Skill
              <select id="skill" value={skill} onChange={(e) => setSkill(Number(e.target.value))}>
                <option value={1}>1 · I&apos;m too young to die</option>
                <option value={2}>2 · Hey, not too rough</option>
                <option value={3}>3 · Hurt me plenty</option>
                <option value={4}>4 · Ultra-violence</option>
                <option value={5}>5 · Nightmare!</option>
              </select>
            </label>
            <label>
              Map
              <select id="map" value={map} onChange={(e) => setMap(Number(e.target.value))}>
                {Array.from({ length: 9 }, (_, i) => (
                  <option key={i} value={i + 1}>E1M{i + 1}</option>
                ))}
              </select>
            </label>
            <label className={s.check}>
              <input id="always-run" type="checkbox" checked={alwaysRun} onChange={(e) => setAlwaysRun(e.target.checked)} />
              Always run
            </label>
            <button type="button" onClick={togglePause} disabled={status.kind !== "ready"}>{paused ? "Resume" : "Pause"}</button>
            <button type="button" onClick={() => setGameId((g) => g + 1)} disabled={status.kind === "loading"}>Restart</button>
          </div>
        )}
      </header>

      <div className={s.stage} ref={stageRef}>
        <div className={s.screen} ref={screenRef}>
          <canvas ref={canvasRef} className={s.canvas} width={320} height={200} aria-label="DOOM game screen" />

          {status.kind !== "ready" && (
            <div className={s.overlay}>
              {status.kind === "loading" ? (
                <p>
                  {status.p.phase === "wad" ? `Downloading Freedoom${pct === null ? "…" : ` ${pct}%`}` : status.p.phase === "engine" ? "Starting the engine…" : "Loading…"}
                </p>
              ) : (
                <p role="alert">Couldn&apos;t start the game: {status.message}</p>
              )}
            </div>
          )}
          {paused && status.kind === "ready" && (
            <button type="button" className={s.overlay} onClick={togglePause}>Paused · tap or click to resume</button>
          )}

        </div>

        {!selftest && (
          <div className={s.pad}>
            <p className={s.padHint}>Drag left side to move · right side to turn</p>
            <div className={s.buttons}>
              <button type="button" className={s.fire} {...btn("fire")}>FIRE</button>
              <button type="button" {...btn("use")}>USE</button>
              <button type="button" onTouchStart={(e) => (e.preventDefault(), inputRef.current?.nextWeapon())}>WPN</button>
            </div>
          </div>
        )}
        {stick && (
          <div className={s.stick} style={{ left: stick.x0, top: stick.y0 }} aria-hidden="true">
            <div className={s.knob} style={{ transform: `translate(${clampPx(stick.dx)}px, ${clampPx(stick.dy)}px)` }} />
          </div>
        )}
      </div>

      {selftest ? (
        <section className={s.selftest} aria-live="polite">
          <h2>Determinism self-test</h2>
          {test ? (
            <>
              <p className={test.ok ? s.pass : s.fail}>{test.ok ? "PASS: browser matches Node" : "FAIL: browser differs from Node"}</p>
              <dl>
                <dt>Replayed</dt><dd>{SELFTEST.tics}+ tics (seed {SELFTEST.seed}) to gametic {test.gametic} in {Math.round(test.ms)} ms</dd>
                <dt>State hash</dt><dd><code>{test.stateHash}</code>{test.stateHash === SELFTEST.stateHash ? " ✓" : ` ✗ expected ${SELFTEST.stateHash}`}</dd>
                <dt>Frame hash</dt><dd><code>{test.frameHash}</code>{test.frameHash === SELFTEST.frameHash ? " ✓" : ` ✗ expected ${SELFTEST.frameHash}`}</dd>
              </dl>
            </>
          ) : (
            <p>Running…</p>
          )}
        </section>
      ) : (
        <section className={s.help}>
          <div>
            <h2>Keyboard and mouse</h2>
            <ul>
              <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>←</kbd><kbd>→</kbd> turn</li>
              <li>Click the screen to aim with the mouse (<kbd>Esc</kbd> releases it)</li>
              <li>Fire: left click, <kbd>Ctrl</kbd> or <kbd>F</kbd> · Open doors: <kbd>Space</kbd>, <kbd>E</kbd> or right click</li>
              <li><kbd>Shift</kbd> walks when Always run is on · <kbd>1</kbd>–<kbd>7</kbd> weapons</li>
            </ul>
          </div>
          <div>
            <h2>Touch</h2>
            <ul>
              <li>Left half: drag to move and strafe</li>
              <li>Right half: drag sideways to turn</li>
              <li>FIRE, USE (doors, switches) and WPN (next weapon) buttons</li>
            </ul>
          </div>
          <p className={s.credit}>
            Same WebAssembly engine Claude plays. Game data: <a href="https://freedoom.github.io">Freedoom</a> (BSD). Not affiliated with id Software.
          </p>
        </section>
      )}
    </main>
  );
}

function clampPx(v: number) {
  return Math.max(-40, Math.min(40, v));
}
