// Fixed-step 35 Hz game loop on requestAnimationFrame: runs as many tics as
// real time allows (capped, so a background tab never "catches up" for
// seconds), then renders once to a 320×200 canvas.

import { TICRATE, type Engine, type PlayerState, type TicStep } from "@doom-player/doom-core/core";

const TIC_MS = 1000 / TICRATE;
const MAX_TICS_PER_FRAME = 4;

export interface LoopOptions {
  engine: Engine;
  canvas: HTMLCanvasElement;
  nextCmd: () => TicStep;
  /** Called after each frame that advanced the game, at most ~10×/s. */
  onState?: (s: PlayerState) => void;
}

export class GameLoop {
  private raf = 0;
  private last = 0;
  private acc = 0;
  private lastState = 0;
  private running = false;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  /** Every tic applied, for debugging and (Phase 6) replay. */
  readonly log: TicStep[] = [];

  constructor(private readonly o: LoopOptions) {
    o.canvas.width = o.engine.width;
    o.canvas.height = o.engine.height;
    this.ctx = o.canvas.getContext("2d", { alpha: false })!;
    this.image = this.ctx.createImageData(o.engine.width, o.engine.height);
    this.draw();
  }

  get isRunning() {
    return this.running;
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

  private frame = (now: number) => {
    if (!this.running) return;
    this.acc += Math.min(now - this.last, TIC_MS * MAX_TICS_PER_FRAME);
    this.last = now;
    let ran = 0;
    while (this.acc >= TIC_MS && ran < MAX_TICS_PER_FRAME) {
      const cmd = this.o.nextCmd();
      this.o.engine.applyTicStep(cmd);
      this.pushLog(cmd);
      this.acc -= TIC_MS;
      ran++;
    }
    if (ran) {
      this.draw();
      if (this.o.onState && now - this.lastState > 100) {
        this.lastState = now;
        this.o.onState(this.o.engine.getState());
      }
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private pushLog(c: TicStep) {
    const prev = this.log[this.log.length - 1];
    if (prev && prev.f === c.f && prev.s === c.s && prev.t === c.t && prev.b === c.b && prev.n < 35) prev.n++;
    else this.log.push({ ...c });
  }

  draw() {
    this.image.data.set(this.o.engine.render());
    this.ctx.putImageData(this.image, 0, 0);
  }
}
