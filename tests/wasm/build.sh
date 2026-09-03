#!/bin/sh
#
# Build the headless wasm test binary used by runtest.js.
#
# It is the ordinary emnp2kai_sdl2 object set, relinked with:
#
#   - np2probe.c, which exposes emulated memory, the composited screen and
#     np2's WAV recorder to JS
#   - SDL's dummy video backend, which SDL_config_emscripten.h leaves out, so
#     the emulator can come up with no DOM at all
#   - MODULARIZE, because node's module scope shadows the global Module the
#     non-modularized output looks for
#
# Usage:
#   tests/wasm/build.sh [cmake build dir]     # default: build-emr
#
# Requires that build dir to be configured with emcmake and already built, so
# the object files exist:
#
#   emcmake cmake -S . -B build-emr -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build build-emr --target emnp2kai_sdl2
#
set -e

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
BUILD=${1:-$ROOT/build-emr}
case $BUILD in
	/* | ?:*) ;;
	*) BUILD=$ROOT/$BUILD ;;
esac
OUT=${OUT:-$BUILD/test}
TARGET=${TARGET:-emnp2kai_sdl2}

if [ ! -f "$BUILD/build.ninja" ]; then
	echo "no build.ninja in $BUILD; configure and build it first" >&2
	exit 1
fi

command -v emcc >/dev/null 2>&1 || { echo "emcc not on PATH" >&2; exit 1; }

mkdir -p "$OUT/obj"

SDL_INC="-I$ROOT/deps/SDL2/include -I$BUILD/deps/include"
SDL_FLAGS="-O1 -DNDEBUG -s USE_SDL=0 -fwrapv-pointer -DUSE_SDL=2 -D__EMSCRIPTEN__
	-Wno-implicit-function-declaration -Wno-incompatible-pointer-types -Wno-int-conversion"

echo "==> SDL dummy video backend"
for f in video/SDL_video.c \
	 video/dummy/SDL_nullvideo.c \
	 video/dummy/SDL_nullevents.c \
	 video/dummy/SDL_nullframebuffer.c; do
	# shellcheck disable=SC2086
	emcc $SDL_FLAGS -DSDL_VIDEO_DRIVER_DUMMY=1 $SDL_INC \
		-c "$ROOT/deps/SDL2/src/$f" \
		-o "$OUT/obj/$(echo "$f" | tr / _).o"
done

echo "==> np2probe.c"
emcc -DUSE_SDL=2 -D__EMSCRIPTEN__ -DEMSCRIPTEN -DNP2_SDL -DSUPPORT_SDL_AUDIO \
	-DSUPPORT_16BPP -O1 -DNDEBUG -s USE_SDL=0 \
	-Wno-implicit-function-declaration -Wno-incompatible-pointer-types \
	-Wno-int-conversion \
	-I"$ROOT" -I"$ROOT/sdl" -I"$ROOT/sdl/em" -I"$ROOT/i286c" $SDL_INC \
	-include "$ROOT/sdl/em/compiler.h" \
	-c "$ROOT/tests/wasm/np2probe.c" -o "$OUT/obj/np2probe.o"

# The link line ninja uses lists every object and archive; reuse it rather
# than duplicating the source list here. Ninja writes its .rsp only while
# building, so pull the list out of build.ninja itself.
echo "==> collecting objects for $TARGET"
python - "$BUILD" "$TARGET" <<'PYEOF' > "$OUT/objs.rsp"
import io, re, sys
build, target = sys.argv[1], sys.argv[2]
s = io.open(build + '/build.ninja', encoding='utf-8', errors='replace').read()
i = s.index('build ' + target + '.html:')
line = s[i:s.index(chr(10), i)]
objs = re.findall(r'\S+\.o\b', line)
libs = re.findall(r'deps/\S+\.a', line)
if not objs:
    raise SystemExit('no objects found for ' + target)
sys.stdout.write(chr(10).join(objs + libs))
PYEOF

echo "==> linking $OUT/np2test.js"
cd "$BUILD"
em++ -O3 -DNDEBUG \
	-s INITIAL_MEMORY=67108864 -s MAXIMUM_MEMORY=1073741824 \
	-s ASYNCIFY -s ALLOW_MEMORY_GROWTH=1 -s ASSERTIONS=1 \
	-s USE_SDL=0 -s GL_ENABLE_GET_PROC_ADDRESS=1 --profiling-funcs \
	-s MODULARIZE=1 -s EXPORT_NAME=createNP2 \
	-s "EXPORTED_RUNTIME_METHODS=['FS','callMain','ENV','HEAPU8','ccall','UTF8ToString']" \
	-s "EXPORTED_FUNCTIONS=['_main','_np2probe_textvram','_np2probe_mem','_np2probe_screen','_np2probe_screen_width','_np2probe_screen_height','_np2probe_screen_bpp','_np2probe_screen_pitch','_np2probe_recstart','_np2probe_recstop','_np2probe_isrecording','_np2probe_rhythmcaps','_np2probe_biosresolve','_np2probe_canopen']" \
	"$OUT"/obj/*.o @"$OUT/objs.rsp" -o "$OUT/np2test.js"

cp "$ROOT/tests/wasm/runtest.js" "$OUT/runtest.js"

cat <<EOF

built $OUT/np2test.js

run it with, for example:

  cd $OUT
  FONT_ROM=$ROOT/web/bios/font.rom BIOS_DIR=$ROOT/web/bios \\
  SHOT=shot.png WAV=out.wav RUN_SECONDS=20 \\
    node runtest.js $ROOT/web/disk/fd98_2hd.img
EOF
