// Headless doomgeneric platform layer for doom-player.
//
// The clock is virtual: it only advances when JS calls doom_step() (one tic
// per game tic) or when the engine itself calls DG_SleepMs() inside a busy
// wait (the screen wipe at boot). Wall-clock time is never read, which is
// what makes replays deterministic.

#include <stdint.h>
#include "doomgeneric.h"

// Number of game tics requested by JS so far.
uint32_t dg_tic = 0;
// Virtual milliseconds consumed by DG_SleepMs (busy waits inside the engine).
uint32_t dg_sleep_ms = 0;
// Number of frames presented through DG_DrawFrame.
uint32_t dg_frames = 0;

void DG_Init(void) {}

void DG_DrawFrame(void) { dg_frames++; }

void DG_SleepMs(uint32_t ms) { dg_sleep_ms += ms ? ms : 1; }

uint32_t DG_GetTicksMs(void) {
  // Starts at 1 so I_GetTime's "basetime == 0" check latches on the first call.
  // (tic * 1000 + 34) / 35 makes (ms * 35) / 1000 == tic exactly.
  return 1 + (dg_tic * 1000u + 34u) / 35u + dg_sleep_ms;
}

// Fallback key path: a tiny ring buffer filled from JS. Gameplay input goes
// through ticcmd injection instead (see dg_exports.c).
#define KEYQ 64
static uint16_t keyq[KEYQ];
static unsigned keyq_r = 0, keyq_w = 0;

void doom_push_key(int pressed, int key) {
  keyq[keyq_w++ % KEYQ] = (uint16_t)(((pressed ? 1 : 0) << 8) | (key & 0xff));
}

int DG_GetKey(int *pressed, unsigned char *key) {
  if (keyq_r == keyq_w) return 0;
  uint16_t k = keyq[keyq_r++ % KEYQ];
  *pressed = k >> 8;
  *key = k & 0xff;
  return 1;
}

void DG_SetWindowTitle(const char *title) { (void)title; }
