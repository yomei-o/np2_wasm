# Headless wasm test harness

Runs the Emscripten build under node with no browser, and reports what the
emulated machine actually did: the PC-98 text VRAM, a PNG of the composited
screen, and a WAV of the sound output.

This exists because the first working wasm build came up with a black screen
and a bare `function signature mismatch` at a wasm byte offset. Being able to
boot a disk image and look at the screen without a browser is what turns that
kind of report into a fix.

## Running

```sh
tests/wasm/build.sh                 # needs build-emr configured and built
cd build-emr/test
FONT_ROM=../../web/bios/font.rom BIOS_DIR=../../web/bios \
SHOT=shot.png WAV=out.wav RUN_SECONDS=20 \
  node runtest.js ../../web/disk/fd98_2hd.img
```

Output for the FreeDOS(98) floppy looks like:

```
mounted /disk/fd98_2hd.img (1261568 bytes)
[err] Loading np2kai.cfg from /np2kai.cfg
recstart -> 1
--- text VRAM after 20s ---------------------------------------------------
 0|(C) Copyright 1995-2022 Pasquale J. Villani and The FreeDOS Project.
 6|A: FD0 2HD #0 (2HD/2DD)
 7|B: FD1 2HD #1 (2HD/2DD)
10|FreeDOS XMS-Driver for 80286
16|Information: 80286 16MB version [PC-98]
22|FreeCom ver 0.85a_DBCS - WATCOMC - XMS_Swap (PC98)
23|A:\>
---------------------------------------------------------------------------
rhythm samples loaded: 0x3f (all six)
wav 3914224 bytes (22.19s stereo) peak=8033 mean=714.2 -> out.wav
screen 640x400 16bpp pitch=1280 non-black 8.8% -> shot.png
RESULT: ran with no trap, 25 non-empty text rows
```

### Environment

| | |
|---|---|
| `RUN_SECONDS` | how long to let the emulator run (default 6) |
| `FONT_ROM` | `font.rom` to mount, for kanji |
| `BIOS_DIR` | directory to take the `2608_*.wav` rhythm samples from |
| `SHOT` | write a PNG of the screen here |
| `WAV` | write a WAV of the sound here |
| `WAV_DELAY` | ms to wait before starting to record (default 2000) |
| `SND` | `SNDboard` value, e.g. `02` for 26K, `04` for 86 (default `02`) |
| `FMGEN` | `USEFMGEN`: `true` for fmgen, `false` for np2's opngen (default `false`) |
| `GRCG_EGC` via `GRCG` | `3` for EGC (default) |
| `EXTMEM` | `ExMemory` in MB (default 1) |
| `KEYS` | key script, e.g. `6000:ret,14000:ret` - at 6s and 14s tap Return |
| `KEY_HOLD` | ms to hold each key down (default 80) |

`KEYS` steps are `<ms>:<key>[+<key>...]`, comma separated, with the times
measured from startup. Key names are the `NKEY_*` set from keystat.h
(`ret`, `esc`, `space`, `up`/`down`/`left`/`right`, `f1`-`f10`, letters,
digits); a raw code like `0x1c` also works. Keys go in through
`keystat_senddata()`, the same queue the real keyboard feeds.

Positional arguments are disk images, mounted into FDD1 then FDD2, exactly as
`np2_main()` treats its own positional arguments.

## How it avoids needing a browser

**Video.** SDL picks the Emscripten backend, which calls
`emscripten_get_screen_size()` and dies on `screen is not defined` under node.
SDL's dummy video driver needs no DOM, but `SDL_config_emscripten.h` does not
define `SDL_VIDEO_DRIVER_DUMMY`, so `build.sh` recompiles `SDL_video.c` and the
three `video/dummy/` files with it defined and links them ahead of
`libnp2kai_SDL2.a`. `runtest.js` then sets `SDL_VIDEODRIVER=dummy` through
`Module.ENV`.

**Audio.** np2 will not create its sound engine at all without an audio device
(`pccore.c` `sound_init` -> `sound_create` -> `soundmng_create`), and SDL's
dummy and disk audio drivers both want a thread, which this build does not
have. So `runtest.js` stubs just enough `AudioContext` for SDL's Emscripten
audio backend to open a device. Nothing ever pumps it - it does not need to be,
because np2 mixes from the device write paths (`sound_sync()`), not from the
audio callback, and `SUPPORT_WAVEREC` recording is driven from there too.

**Reading state back.** `np2probe.c` exports a handful of accessors:
`np2probe_textvram()` for the text plane, `np2probe_screen()` for
`scrnmng.pc98surf` (the composited screen, RGB565 in this build),
`np2probe_recstart()`/`np2probe_recstop()` for the WAV recorder,
`np2probe_rhythmcaps()` for which `2608_*.wav` loaded, and
`np2probe_biosresolve()`/`np2probe_canopen()` for debugging where np2 looks for
BIOS-directory files, `np2probe_key()` to inject keyboard scan codes, and the
`np2probe_egc_*()`/`np2probe_vramop()`/`np2probe_grcg_chip()` set to report
whether the guest ever turned the EGC blitter on and programmed it. It is linked only into this test binary.

`--profiling-funcs` keeps the wasm name section, so a trap in either the test
binary or the shipped one names the function instead of printing a byte offset.
