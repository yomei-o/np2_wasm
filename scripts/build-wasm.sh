#!/bin/sh
#
# Build the Emscripten (wasm) port of NP2kai.
#
# Everything the wasm build links against (SDL2, libpng, zlib) is vendored
# under deps/, so the only external requirement is the Emscripten SDK. If emcc
# is not already on PATH this script fetches a pinned emsdk into .emsdk/ and
# uses that.
#
# Usage:
#   scripts/build-wasm.sh [ninja target ...]
#
# Environment:
#   EMSDK           use an existing emsdk installation at this path
#   EMSDK_VERSION   emsdk release to install when bootstrapping (default 6.0.0)
#   BUILD_DIR       build directory (default build-em)
#   BUILD_TYPE      CMake build type (default Release)
#   JOBS            parallel compile jobs (default: number of CPUs)
#
set -e

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EMSDK_VERSION=${EMSDK_VERSION:-6.0.0}
BUILD_DIR=${BUILD_DIR:-build-em}
BUILD_TYPE=${BUILD_TYPE:-Release}
JOBS=${JOBS:-$( (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4) )}

case $BUILD_DIR in
	/* | ?:*) ;;
	*) BUILD_DIR=$ROOT/$BUILD_DIR ;;
esac

# ---------------------------------------------------------------- toolchain
# Note: emsdk_env.sh is deliberately not used. It needs a working `python` on
# PATH, and on Windows the Microsoft Store python execution alias answers that
# probe without being a Python, which makes it fail silently. Pointing at the
# tool directory directly works everywhere.
activate_emsdk() {
	emsdk_root=$1
	if [ ! -x "$emsdk_root/upstream/emscripten/emcc" ] &&
	   [ ! -f "$emsdk_root/upstream/emscripten/emcc.py" ]; then
		return 1
	fi
	EM_CONFIG=$emsdk_root/.emscripten
	export EM_CONFIG
	EMSDK=$emsdk_root
	export EMSDK
	PATH=$emsdk_root/upstream/emscripten:$PATH
	node_dir=$(ls -d "$emsdk_root"/node/*/bin 2>/dev/null | head -n 1)
	if [ -n "$node_dir" ]; then
		PATH=$node_dir:$PATH
	fi
	export PATH
	return 0
}

if command -v emcc >/dev/null 2>&1; then
	echo "==> using emcc already on PATH"
elif [ -n "$EMSDK" ] && activate_emsdk "$EMSDK"; then
	echo "==> using emsdk at $EMSDK"
else
	emsdk_root=$ROOT/.emsdk
	if ! activate_emsdk "$emsdk_root"; then
		echo "==> bootstrapping emsdk $EMSDK_VERSION into $emsdk_root"
		if [ ! -d "$emsdk_root/.git" ]; then
			git clone --depth 1 https://github.com/emscripten-core/emsdk "$emsdk_root"
		fi
		"$emsdk_root/emsdk" install "$EMSDK_VERSION"
		"$emsdk_root/emsdk" activate "$EMSDK_VERSION"
		activate_emsdk "$emsdk_root"
	fi
	echo "==> using emsdk at $emsdk_root"
fi

emcc --version | head -n 1

# -------------------------------------------------------------------- build
if command -v ninja >/dev/null 2>&1; then
	generator=Ninja
else
	generator="Unix Makefiles"
fi

echo "==> configuring ($generator, $BUILD_TYPE)"
emcmake cmake -S "$ROOT" -B "$BUILD_DIR" -G "$generator" \
	-DCMAKE_BUILD_TYPE="$BUILD_TYPE"

targets=${*:-emnp21kai_sdl2}
echo "==> building $targets"
for t in $targets; do
	cmake --build "$BUILD_DIR" --target "$t" -- -j"$JOBS"
done

echo
echo "==> output in $BUILD_DIR"
for t in $targets; do
	ls -l "$BUILD_DIR/$t.html" "$BUILD_DIR/$t.js" "$BUILD_DIR/$t.wasm" 2>/dev/null || true
done
echo
echo "Run it with:  emrun $BUILD_DIR/emnp21kai_sdl2.html"
