// JS-facing API for doom-player: boot, step N tics with an injected ticcmd,
// render on demand, and read structured game state.

#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <emscripten/emscripten.h>

#include "doomgeneric.h"
#include "doomstat.h"
#include "d_player.h"
#include "d_ticcmd.h"
#include "p_local.h"
#include "r_main.h"
#include "r_state.h"
#include "tables.h"

extern boolean singletics;
extern int gametic;
extern uint32_t dg_tic;
extern uint32_t dg_frames;
extern uint32_t dg_sleep_ms;

void D_Display(void);
void I_StartFrame(void);
void TryRunTics(void);

// ---------------------------------------------------------------------------
// ticcmd injection (called from the patched BuildNewTic in d_loop.c)

static ticcmd_t inj;
static int inj_on = 0;

void DG_PostBuildTiccmd(ticcmd_t *cmd) {
  if (!inj_on) return;
  cmd->forwardmove = inj.forwardmove;
  cmd->sidemove = inj.sidemove;
  cmd->angleturn = inj.angleturn;
  cmd->buttons = inj.buttons;
  cmd->chatchar = 0;
  // cmd->consistancy is left as computed by G_BuildTiccmd.
}

// ---------------------------------------------------------------------------
// boot

static char arg_skill[4], arg_ep[4], arg_map[4];
static char *argv_buf[16];

EMSCRIPTEN_KEEPALIVE
int doom_init(int skill, int episode, int map) {
  int argc = 0;
  snprintf(arg_skill, sizeof arg_skill, "%d", skill);
  snprintf(arg_ep, sizeof arg_ep, "%d", episode);
  snprintf(arg_map, sizeof arg_map, "%d", map);
  argv_buf[argc++] = "doom";
  argv_buf[argc++] = "-iwad";
  argv_buf[argc++] = "/doom.wad";
  argv_buf[argc++] = "-skill";
  argv_buf[argc++] = arg_skill;
  argv_buf[argc++] = "-warp";
  argv_buf[argc++] = arg_ep;
  argv_buf[argc++] = arg_map;
  argv_buf[argc++] = "-nosound";
  argv_buf[argc++] = "-nomusic";
  argv_buf[argc] = NULL;

  // One game tic per TryRunTics call, with no wall-clock catch-up
  // (the same mode -timedemo uses). Must be set before the engine boots.
  singletics = true;
  doomgeneric_Create(argc, argv_buf);
  inj_on = 1;
  memset(&inj, 0, sizeof inj);
  return gametic;
}

// ---------------------------------------------------------------------------
// step / render

// Runs `tics` game tics with the given ticcmd. Returns the new gametic, or
// -(i+1) if tic i did not advance gametic by exactly one (a broken clock).
EMSCRIPTEN_KEEPALIVE
int doom_step(int forward, int side, int turn, int buttons, int tics) {
  inj.forwardmove = (signed char)forward;
  inj.sidemove = (signed char)side;
  inj.angleturn = (short)turn;
  inj.buttons = (byte)buttons;
  for (int i = 0; i < tics; i++) {
    int before = gametic;
    dg_tic++;
    I_StartFrame();
    TryRunTics();
    if (gametic != before + 1) return -(i + 1);
  }
  return gametic;
}

// Draws the current state into DG_ScreenBuffer (XRGB8888, little endian:
// bytes are B,G,R,X). Rendering never feeds back into game logic.
EMSCRIPTEN_KEEPALIVE
void doom_render(void) {
  wipegamestate = gamestate;  // never start a (busy-waiting) screen wipe
  D_Display();
}

EMSCRIPTEN_KEEPALIVE
uint32_t *doom_frame_ptr(void) { return DG_ScreenBuffer; }

EMSCRIPTEN_KEEPALIVE
int doom_frame_width(void) { return DOOMGENERIC_RESX; }

EMSCRIPTEN_KEEPALIVE
int doom_frame_height(void) { return DOOMGENERIC_RESY; }

// ---------------------------------------------------------------------------
// state

// Layout is mirrored in packages/doom-core/src/layout.ts. Append only.
enum {
  S_GAMETIC, S_GAMESTATE, S_EPISODE, S_MAP, S_PLAYERSTATE,
  S_HEALTH, S_ARMOR, S_ARMORTYPE,
  S_AMMO0, S_AMMO1, S_AMMO2, S_AMMO3,
  S_MAXAMMO0, S_MAXAMMO1, S_MAXAMMO2, S_MAXAMMO3,
  S_READYWEAPON, S_PENDINGWEAPON, S_WEAPONS_MASK,
  S_X, S_Y, S_Z, S_ANGLE, S_ONGROUND, S_MOMX, S_MOMY,
  S_KILLS, S_ITEMS, S_SECRETS, S_TOTALKILLS, S_TOTALITEMS, S_TOTALSECRETS,
  S_DAMAGECOUNT, S_BONUSCOUNT, S_CARDS_MASK, S_LEVELTIME, S_ATTACKER_ANGLE,
  S_HAS_ATTACKER, S_USEDOWN, S_ATTACKDOWN, S_FRAMES, S_SLEEP_MS,
  S_COUNT
};
static int32_t st[S_COUNT];

static int32_t rel_angle(mobj_t *from, fixed_t x, fixed_t y) {
  // R_PointToAngle2 writes viewx/viewy; save and restore so observation
  // leaves renderer globals untouched.
  fixed_t vx = viewx, vy = viewy;
  angle_t a = R_PointToAngle2(from->x, from->y, x, y) - from->angle;
  viewx = vx;
  viewy = vy;
  return (int32_t)a;  // BAM, signed: >0 = to the left (counter-clockwise)
}

EMSCRIPTEN_KEEPALIVE
int32_t *doom_get_state(void) {
  player_t *p = &players[consoleplayer];
  mobj_t *mo = p->mo;
  memset(st, 0, sizeof st);
  st[S_GAMETIC] = gametic;
  st[S_GAMESTATE] = gamestate;
  st[S_EPISODE] = gameepisode;
  st[S_MAP] = gamemap;
  st[S_PLAYERSTATE] = p->playerstate;
  st[S_HEALTH] = p->health;
  st[S_ARMOR] = p->armorpoints;
  st[S_ARMORTYPE] = p->armortype;
  for (int i = 0; i < 4; i++) {
    st[S_AMMO0 + i] = p->ammo[i];
    st[S_MAXAMMO0 + i] = p->maxammo[i];
  }
  st[S_READYWEAPON] = p->readyweapon;
  st[S_PENDINGWEAPON] = p->pendingweapon;
  for (int i = 0; i < NUMWEAPONS; i++)
    if (p->weaponowned[i]) st[S_WEAPONS_MASK] |= 1 << i;
  if (mo) {
    st[S_X] = mo->x;
    st[S_Y] = mo->y;
    st[S_Z] = mo->z;
    st[S_ANGLE] = (int32_t)mo->angle;
    st[S_ONGROUND] = mo->z <= mo->floorz;
    st[S_MOMX] = mo->momx;
    st[S_MOMY] = mo->momy;
  }
  st[S_KILLS] = p->killcount;
  st[S_ITEMS] = p->itemcount;
  st[S_SECRETS] = p->secretcount;
  st[S_TOTALKILLS] = totalkills;
  st[S_TOTALITEMS] = totalitems;
  st[S_TOTALSECRETS] = totalsecret;
  st[S_DAMAGECOUNT] = p->damagecount;
  st[S_BONUSCOUNT] = p->bonuscount;
  for (int i = 0; i < NUMCARDS; i++)
    if (p->cards[i]) st[S_CARDS_MASK] |= 1 << i;
  st[S_LEVELTIME] = leveltime;
  if (mo && p->attacker && p->attacker != mo) {
    st[S_HAS_ATTACKER] = 1;
    st[S_ATTACKER_ANGLE] = rel_angle(mo, p->attacker->x, p->attacker->y);
  }
  st[S_USEDOWN] = p->usedown;
  st[S_ATTACKDOWN] = p->attackdown;
  st[S_FRAMES] = (int32_t)dg_frames;
  st[S_SLEEP_MS] = (int32_t)dg_sleep_ms;
  return st;
}

EMSCRIPTEN_KEEPALIVE
int doom_state_len(void) { return S_COUNT; }

// ---------------------------------------------------------------------------
// objects (enemies, items, other shootables) around the player

#define MAX_OBJS 256
enum { O_ID, O_TYPE, O_X, O_Y, O_Z, O_HEALTH, O_FLAGS, O_DIST, O_ANGLE, O_VISIBLE, O_STRIDE };
static int32_t objs[MAX_OBJS * O_STRIDE];

// Fills the object table with every mobj within `max_dist` map units that is
// a monster, a pickup or shootable. Returns the count. `id` is the mobj's
// address, which is stable for the life of the object and identical across
// replays of the same log.
EMSCRIPTEN_KEEPALIVE
int doom_get_objects(int max_dist) {
  player_t *p = &players[consoleplayer];
  mobj_t *pmo = p->mo;
  int n = 0;
  if (!pmo || gamestate != GS_LEVEL) return 0;
  for (thinker_t *th = thinkercap.next; th != &thinkercap && n < MAX_OBJS; th = th->next) {
    if (th->function.acp1 != (actionf_p1)P_MobjThinker) continue;
    mobj_t *mo = (mobj_t *)th;
    if (mo == pmo) continue;
    if (!(mo->flags & (MF_COUNTKILL | MF_SPECIAL | MF_SHOOTABLE))) continue;
    int dist = P_AproxDistance(mo->x - pmo->x, mo->y - pmo->y) >> FRACBITS;
    if (dist > max_dist) continue;
    int32_t *o = &objs[n * O_STRIDE];
    o[O_ID] = (int32_t)(uintptr_t)mo;
    o[O_TYPE] = mo->type;
    o[O_X] = mo->x;
    o[O_Y] = mo->y;
    o[O_Z] = mo->z;
    o[O_HEALTH] = mo->health;
    o[O_FLAGS] = mo->flags;
    o[O_DIST] = dist;
    o[O_ANGLE] = rel_angle(pmo, mo->x, mo->y);
    o[O_VISIBLE] = P_CheckSight(pmo, mo) ? 1 : 0;
    n++;
  }
  return n;
}

EMSCRIPTEN_KEEPALIVE
int32_t *doom_objects_ptr(void) { return objs; }

EMSCRIPTEN_KEEPALIVE
int doom_object_stride(void) { return O_STRIDE; }
