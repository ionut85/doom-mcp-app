#!/usr/bin/env bash
# Builds the headless doomgeneric engine to engine/dist/doom.mjs + doom.wasm.
# Upstream sources are copied to engine/build/src and patched there, so the
# submodule itself stays pristine.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/doomgeneric/doomgeneric"
WORK="$HERE/build/src"
DIST="$HERE/dist"

command -v emcc >/dev/null || { echo "emcc not found: source ~/emsdk/emsdk_env.sh (version: $(cat "$HERE/emsdk-version.txt"))"; exit 1; }
WANT="$(cat "$HERE/emsdk-version.txt")"
HAVE="$(emcc --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[ "$WANT" = "$HAVE" ] || echo "warning: emcc $HAVE, pinned $WANT; output may differ from committed dist/"

rm -rf "$WORK" && mkdir -p "$WORK" "$DIST"
cp "$SRC"/*.c "$SRC"/*.h "$WORK"/
for p in "$HERE"/patches/*.patch; do
  patch -s -d "$WORK" -p2 < "$p"
done
cp "$HERE/dg_headless.c" "$HERE/dg_exports.c" "$WORK"/

# Same object list as upstream's Makefile, minus platform backends and SDL sound.
OBJS="dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop d_main d_mode d_net f_finale f_wipe g_game hu_lib hu_stuff info i_cdmus i_endoom i_joystick i_scale i_sound i_system i_timer memio m_argv m_bbox m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng p_doors p_enemy p_floor p_inter p_lights p_map p_maputl p_mobj p_plats p_pspr p_saveg p_setup p_sight p_spec p_switch p_telept p_tick p_user r_bsp r_data r_draw r_main r_plane r_segs r_sky r_things sha1 sounds statdump st_lib st_stuff s_sound tables v_video wi_stuff w_checksum w_file w_main w_wad z_zone w_file_stdc i_input i_video doomgeneric dg_headless dg_exports"
FILES=""
for o in $OBJS; do FILES="$FILES $WORK/$o.c"; done

EXPORTS='["_doom_init","_doom_step","_doom_render","_doom_frame_ptr","_doom_frame_width","_doom_frame_height","_doom_get_state","_doom_state_len","_doom_get_objects","_doom_objects_ptr","_doom_object_stride","_doom_push_key","_malloc","_free"]'

# shellcheck disable=SC2086
emcc $FILES -o "$DIST/doom.mjs" \
  -O2 -w \
  -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE \
  -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 \
  -I"$WORK" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDoomModule \
  -sENVIRONMENT=node,web \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sFILESYSTEM=1 -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS='["FS","HEAP32","HEAPU8","HEAPU32"]'

# mobjtype_t enum names, index = mo->type.
python3 - "$WORK/info.h" "$DIST/mobjtypes.json" <<'EOF'
import json, re, sys
src = open(sys.argv[1]).read()
body = src[src.index("typedef enum", src.index("MT_PLAYER") - 200):]
body = body[:body.index("mobjtype_t")]
names = re.findall(r"\b(MT_[A-Z0-9_]+)\b", body)
names = [n for n in names if n != "NUMMOBJTYPES"]
json.dump(names, open(sys.argv[2], "w"))
print(f"mobjtypes: {len(names)}")
EOF

ls -la "$DIST"
