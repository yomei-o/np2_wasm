#!/bin/sh
#
# Build pc98fat as its own wasm module for the demo page, and run the native
# self test first so a logic error never reaches the browser.
#
#   tools/pc98fat/build.sh
#
# Output: web/pc98fat.js + web/pc98fat.wasm
#
set -e

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd)

if command -v gcc >/dev/null 2>&1; then
	echo "==> native self test"
	gcc -O1 -Wall -o "$HERE/selftest.exe" "$HERE/selftest.c" "$HERE/pc98fat.c"
	"$HERE/selftest.exe" "$ROOT/web/disk/fd98_2hd.img" "$ROOT/web/disk/lsic_98.xdf"
else
	echo "==> gcc not found, skipping the native self test"
fi

command -v emcc >/dev/null 2>&1 || { echo "emcc not on PATH" >&2; exit 1; }

echo "==> wasm"
emcc -O2 -Wall -Wextra \
	-s MODULARIZE=1 -s EXPORT_NAME=createPc98Fat \
	-s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=16777216 \
	-s "EXPORTED_RUNTIME_METHODS=['ccall','HEAPU8','UTF8ToString']" \
	-s "EXPORTED_FUNCTIONS=['_malloc','_free']" \
	-s EXPORT_ES6=1 \
	"$HERE/pc98fat.c" -o "$ROOT/web/pc98fat.js"

ls -l "$ROOT/web/pc98fat.js" "$ROOT/web/pc98fat.wasm"
