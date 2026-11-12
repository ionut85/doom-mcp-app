// Human input → one DOOM ticcmd per tic. Framework-agnostic: used by /play and
// (Phase 4) the viewer's "Play yourself" mode.

import type { TicStep } from "@doom-player/doom-core/core";

const BT_ATTACK = 1;
const BT_USE = 2;
const BT_CHANGE = 4;

const FORWARD = [25, 50];
const SIDE = [24, 40];
const KEY_TURN = [640, 1280];
/** angleturn units per mouse pixel (65536 = 360°) */
const MOUSE_TURN = 28;
/** angleturn units per touch pixel dragged */
const TOUCH_TURN = 40;
const STICK_RADIUS = 56;

export interface InputOptions {
  alwaysRun: boolean;
  /** Weapons the player owns, as weapon slots 1..7; used by "next weapon". */
  ownedSlots?: () => number[];
}

export class PlayerInput {
  private keys = new Set<string>();
  private mouseDx = 0;
  private mouseFire = false;
  private touchTurnDx = 0;
  private stick: { id: number; x0: number; y0: number; dx: number; dy: number } | null = null;
  private turnTouch: { id: number; x: number } | null = null;
  private held = { fire: false, use: false };
  private pendingWeapon = 0;
  private lastSlot = 2;
  private cleanup: (() => void)[] = [];

  constructor(public opts: InputOptions) {}

  /** The ticcmd for the next tic. Call exactly once per tic. */
  next(): TicStep {
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    const shift = k("ShiftLeft", "ShiftRight");
    const run = this.opts.alwaysRun !== shift ? 1 : 0;
    let f = 0, s = 0, t = 0, b = 0;
    if (k("KeyW", "ArrowUp")) f += FORWARD[run]!;
    if (k("KeyS", "ArrowDown")) f -= FORWARD[run]!;
    if (k("KeyD")) s += SIDE[run]!;
    if (k("KeyA")) s -= SIDE[run]!;
    if (k("ArrowLeft", "KeyQ")) t += KEY_TURN[run]!;
    if (k("ArrowRight")) t -= KEY_TURN[run]!;
    if (this.stick) {
      const nx = Math.max(-1, Math.min(1, this.stick.dx / STICK_RADIUS));
      const ny = Math.max(-1, Math.min(1, this.stick.dy / STICK_RADIUS));
      f -= Math.round(ny * FORWARD[1]!);
      s += Math.round(nx * SIDE[1]!);
    }
    t -= Math.round(this.mouseDx * MOUSE_TURN + this.touchTurnDx * TOUCH_TURN);
    this.mouseDx = 0;
    this.touchTurnDx = 0;
    if (k("ControlLeft", "ControlRight", "KeyF") || this.mouseFire || this.held.fire) b |= BT_ATTACK;
    if (k("Space", "KeyE") || this.held.use) b |= BT_USE;
    if (this.pendingWeapon) {
      b |= BT_CHANGE | ((this.pendingWeapon - 1) << 3);
      this.lastSlot = this.pendingWeapon;
      this.pendingWeapon = 0;
    }
    const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
    return { f: clamp(f, 127), s: clamp(s, 127), t: clamp(t, 32767), b, n: 1 };
  }

  selectWeapon(slot: number) {
    this.pendingWeapon = slot;
  }

  nextWeapon() {
    const owned = this.opts.ownedSlots?.() ?? [1, 2, 3, 4, 5, 6, 7];
    const after = owned.filter((w) => w > this.lastSlot);
    this.selectWeapon(after[0] ?? owned[0] ?? 1);
  }

  setButton(name: "fire" | "use", down: boolean) {
    this.held[name] = down;
  }

  /** Keyboard + mouse (pointer lock on click) on desktop. */
  attachDesktop(target: HTMLElement) {
    const isGameKey = (code: string) =>
      /^(Key[WASDQEF]|Arrow|Space|Shift|Control|Digit[1-7])/.test(code);
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, select, textarea")) return;
      if (!isGameKey(e.code)) return;
      e.preventDefault();
      this.keys.add(e.code);
      const m = /^Digit([1-7])$/.exec(e.code);
      if (m) this.selectWeapon(Number(m[1]));
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.code);
    const blur = () => {
      this.keys.clear();
      this.mouseFire = false;
    };
    const move = (e: MouseEvent) => {
      if (document.pointerLockElement === target) this.mouseDx += e.movementX;
    };
    const mdown = (e: MouseEvent) => {
      if (document.pointerLockElement !== target) {
        target.requestPointerLock?.()?.catch?.(() => {});
        return;
      }
      if (e.button === 0) this.mouseFire = true;
      if (e.button === 2) this.held.use = true;
    };
    const mup = (e: MouseEvent) => {
      if (e.button === 0) this.mouseFire = false;
      if (e.button === 2) this.held.use = false;
    };
    const ctx = (e: Event) => e.preventDefault();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    document.addEventListener("mousemove", move);
    target.addEventListener("mousedown", mdown);
    window.addEventListener("mouseup", mup);
    target.addEventListener("contextmenu", ctx);
    this.cleanup.push(() => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      document.removeEventListener("mousemove", move);
      target.removeEventListener("mousedown", mdown);
      window.removeEventListener("mouseup", mup);
      target.removeEventListener("contextmenu", ctx);
    });
  }

  /** Touch: left half = movement stick, right half = drag to turn. Buttons are wired via setButton. */
  attachTouch(zone: HTMLElement, onStick?: (s: { x0: number; y0: number; dx: number; dy: number } | null) => void) {
    const start = (e: TouchEvent) => {
      const rect = zone.getBoundingClientRect();
      for (const t of Array.from(e.changedTouches)) {
        if ((t.target as HTMLElement)?.closest?.("button")) continue;
        const left = t.clientX - rect.left < rect.width / 2;
        if (left && !this.stick) {
          this.stick = { id: t.identifier, x0: t.clientX, y0: t.clientY, dx: 0, dy: 0 };
          onStick?.(this.stick);
        } else if (!left && !this.turnTouch) {
          this.turnTouch = { id: t.identifier, x: t.clientX };
        }
      }
      e.preventDefault();
    };
    const move = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.stick?.id === t.identifier) {
          this.stick.dx = t.clientX - this.stick.x0;
          this.stick.dy = t.clientY - this.stick.y0;
          onStick?.(this.stick);
        } else if (this.turnTouch?.id === t.identifier) {
          this.touchTurnDx += t.clientX - this.turnTouch.x;
          this.turnTouch.x = t.clientX;
        }
      }
      e.preventDefault();
    };
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.stick?.id === t.identifier) {
          this.stick = null;
          onStick?.(null);
        }
        if (this.turnTouch?.id === t.identifier) this.turnTouch = null;
      }
    };
    zone.addEventListener("touchstart", start, { passive: false });
    zone.addEventListener("touchmove", move, { passive: false });
    zone.addEventListener("touchend", end);
    zone.addEventListener("touchcancel", end);
    this.cleanup.push(() => {
      zone.removeEventListener("touchstart", start);
      zone.removeEventListener("touchmove", move);
      zone.removeEventListener("touchend", end);
      zone.removeEventListener("touchcancel", end);
    });
  }

  detach() {
    this.cleanup.splice(0).forEach((f) => f());
    this.keys.clear();
  }
}
