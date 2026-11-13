// Smooth playback: the viewer runs its own copy of the engine and plays
// Claude's moves at DOOM's real speed (35 tics/s) instead of showing one still
// frame per move. DOOM is deterministic, so replaying the server's input log
// locally reproduces Claude's game exactly.

import type { Engine, PlayerState, TicStep } from "@doom-player/doom-core/core";

const TIC_MS = 1000 / 35;
/** Behind by more than this many tics: play at double speed. */
const FAST_BEHIND = 105; // 3 s
/** Behind by more than this many tics: jump straight to the latest move. */
const JUMP_BEHIND = 350; // 10 s

export class SmoothPlayer {
  private queue: TicStep[] = [];
  private raf = 0;
  private last = 0;
  private acc = 0;
  private lastStateAt = 0;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  running = false;
  /** Server steps already applied or queued. */
  appliedSteps = 0;

  constructor(
    readonly engine: Engine,
    private readonly canvas: HTMLCanvasElement,
    private readonly onState: (s: PlayerState, behindTics: number) => void,
  ) {
    canvas.width = engine.width;
    canvas.height = engine.height;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.image = this.ctx.createImageData(engine.width, engine.height);
  }

  /** Applies steps instantly (catching up), without animation. */
  replayNow(steps: TicStep[]) {
    this.engine.replay(steps);
    this.appliedSteps += steps.length;
    this.draw();
    this.onState(this.engine.getState(), this.behind());
  }

  /** Queues new steps to be played at real speed. */
  enqueue(steps: TicStep[]) {
    for (const s of steps) this.queue.push({ ...s });
    this.appliedSteps += steps.length;
  }

  behind(): number {
    return this.queue.reduce((a, s) => a + s.n, 0);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tic() {
    const head = this.queue[0]!;
    this.engine.applyTicStep({ ...head, n: 1 });
    if (--head.n <= 0) this.queue.shift();
  }

  private frame = (now: number) => {
    if (!this.running) return;
    const dt = Math.min(now - this.last, 250);
    this.last = now;
    let ran = 0;
    const behind = this.behind();
    if (behind > JUMP_BEHIND) {
      // Too far behind (e.g. the tab was hidden): catch up at once.
      while (this.queue.length) this.tic();
      ran = behind;
      this.acc = 0;
    } else if (behind > 0) {
      this.acc += dt * (behind > FAST_BEHIND ? 2 : 1);
      while (this.acc >= TIC_MS && this.queue.length) {
        this.tic();
        this.acc -= TIC_MS;
        ran++;
      }
    } else {
      this.acc = 0; // idle: Claude is thinking, and the game is frozen on the server too
    }
    if (ran) {
      this.draw();
      if (now - this.lastStateAt > 100 || !this.queue.length) {
        this.lastStateAt = now;
        this.onState(this.engine.getState(), this.behind());
      }
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  draw() {
    this.image.data.set(this.engine.render());
    this.ctx.putImageData(this.image, 0, 0);
  }
}
