# Where the wasm port stands

A record of what was changed, why, and what is still open — enough to pick the
work back up. Live at **https://yomei-o.github.io/np2_wasm/**.

This is a fork of [AZO234/NP2kai](https://github.com/AZO234/NP2kai); `wx_alpha`
tracks upstream, `main` carries this work.

## The short version

The CMake Emscripten port did not configure, and once it did the emulator came
up as a black screen. It now boots FreeDOS(98), runs PC-98 software, produces
sound, keeps disks across reloads, makes its own formatted hard disks, and
moves files in and out of images without booting. The build needs nothing but
the Emscripten SDK.

## What was wrong, and what fixed it

### The build did not configure

`CMakeLists.txt` gated every Emscripten branch on `if(__EMSCRIPTEN__)`, but the
toolchain file only ever sets `EMSCRIPTEN`, so all of it was dead code. Beyond
that: `find_package(PNG REQUIRED)` only runs when not cross-compiling, so
`PNG::PNG` did not exist; `-lssl -lcrypto` were linked though Emscripten has no
OpenSSL; `USE_SDL` is forced to 2 yet the SDL1 and SDL3 executables stayed in
`all` and failed at link; `-s ASYNCIFY` was missing although `np2exec()` and
`taskmng_sleep()` call `emscripten_sleep()`; and `OUTPUT_QUIET` on the
`git describe` call was discarding `OUTPUT_VARIABLE`, so the version string was
always empty. `sdl/mousemng.c` also called `mousemng_hidecursor()` and
`mousemng_showcursor()` without the `SDL_Window *` they had grown.

### The black screen

```
Uncaught RuntimeError: function signature mismatch
    at emnp2kai_sdl2.wasm:0x84bdd
```

`bmsio_reset()` was declared `void(void)` but sits in `cbuscore.c`'s
`FNIORESET` table, whose type is `void(*)(const NP2CFG *)`. Natively the extra
argument is ignored; on wasm an indirect call whose signature does not match
the table entry traps, and it did so in `pccore_reset()` before anything drew.

A build with `-Wincompatible-function-pointer-types` turned back on finds 1325
further mismatches, but every one of them is `UINT8` against `UINT` on an
`IOOUT`/`IOINP` handler. Those share a wasm signature — both lower to `i32` —
so they do not trap and were left alone. Linking with `--profiling-funcs` is
what made this findable: without the name section a trap is a byte offset.

### Everything was at a quarter speed in a browser

The headless harness reported 91–99% of the configured 12.288MHz while the
browser crawled, so the cost was somewhere a browser has and node does not.

`np2exec()` yields once per iteration and `taskmng_sleep()` is the frame
limiter, and both used `emscripten_sleep()`, which ASYNCIFY unwinds through
`setTimeout`. Browsers clamp a nested `setTimeout` to 4ms; node does not.
Instrumenting `setTimeout` showed 66 yields a second — 264ms of every second
sitting in a timer — and the frame limiter is worse than that arithmetic
suggests, because it waits in 1ms steps until `GETTICK()` catches up and so
overshoots every step by 3ms.

Both now call `np2wasm_yield()` (`sdl/em/np2wasm_api.c`), which awaits a
MessageChannel round trip through `EM_ASYNC_JS`. Still an ordinary task, so the
browser keeps its rendering opportunity, but with no minimum delay — the same
reason React's scheduler uses MessageChannel.

|                     | before | after |
|---|---|---|
| FreeDOS(98) idle    | 99%    | 100%  |
| Lord Monarch        | 91%    | 100%  |
| `setTimeout` yields | 66/s   | 0/s   |

## What was added

**Vendored dependencies.** SDL2 2.32.10, libpng 1.6.58 and zlib 1.3.2 live
under `deps/` and build from source, so nothing is fetched from
emscripten-ports. `deps/CMakeLists.txt` exposes them as `SDL2::SDL2`,
`PNG::PNG` and `ZLIB::ZLIB` behind `USE_VENDORED_DEPS`, on for Emscripten and
off elsewhere. SDL2_ttf was dropped rather than vendored — the Emscripten build
never defines `SUPPORT_SDL_TTF`.

**A headless harness** (`tests/wasm/`). Runs the emulator under node with no
browser and reports the text screen, a PNG of the display, a WAV of the sound,
and the speed it reached. SDL's dummy video driver needs no DOM but
`SDL_config_emscripten.h` leaves it out, so `build.sh` recompiles `SDL_video.c`
and `video/dummy/*` with `SDL_VIDEO_DRIVER_DUMMY` and links them ahead of the
archive. Audio needs a stub `AudioContext` only because np2 will not create its
sound engine without a device; nothing pumps it, since np2 mixes from the
device write paths. `np2probe.c` exposes emulated memory, the composited screen,
the WAV recorder, the EGC registers and keyboard injection. Typing works:
`KEYS="14000:@btnpart --format,20000:ret"`.

**Sound.** `SUPPORT_WAVEREC` is enabled for the SDL ports, which the windows,
wx and x ports already had — that gives both the harness and the browser a
recorder. The board is selectable (26K, 86, 86+26K, 86+ADPCM, 118) as is the FM
core (fmgen or opngen). Substitute OPNA rhythm samples are bundled under both
spellings, because `rhythmc.c` opens the lowercase names and fmgen's
`OPNA::LoadRhythmSample()` the uppercase ones, and MEMFS is case-sensitive.

**Disks that persist.** The emulator mounts disks only at startup, so booting
from an image means reloading with it already assigned — and MEMFS does not
survive a reload. Images now live in IndexedDB and the drive assignment in
localStorage, with per-disk eject, save and download.

**SCSI hard disks.** One button builds a `.hdn` image up to 100MB with a PC-98
partition table and an empty FAT16 volume in place. The layout was not guessed:
a blank image was partitioned by FreeDOS(98)'s own `BTNPART.EXE` inside the
harness and read back, which corrected `reserved=2` and 3072 root entries and
pinned down the partition entry, whose name field starts at +16. `BTNPART`
prints `IPL(MBR) 書き換え…OK` but sector 0 comes back untouched under np2's SCSI
emulation, and with it blank the FreeDOS(98) kernel offers the partition no
drive letter at all — so the IPL is written directly.

**pc98fat** (`tools/pc98fat/`). FAT12/FAT16 in C, built to its own 26KB wasm
module, driving the page's ディスクの中身 panel. This is what makes writing code
on the host and compiling it on the PC-98 practical. Cross-checked against
`tools/fatimg.py`, an independent implementation of the same formats.

## Verified

Not "it compiles" — actually run:

- FreeDOS(98) boots to `A:\>` with both floppy drives present and the 80286 XMS
  driver, reporting the 1MB of extended memory the config asks for.
- Lord Monarch reaches its title screen and then the game, reporting
  `CPU Power Level 3`, `FM sound Driver` and `Disk Caching 1152 KB`; 51 seconds
  of its music was recorded, and it asks for a disk in Drive 2, which is why
  two drives matter.
- 倉庫番 Select 30 renders its title screen, Kao logo and all.
- A generated 100MB hard disk mounts as `C:`, takes a file and reports
  104,445,952 bytes free.
- LSI C-86 compiles and runs a program from the bundled floppy.
- A `.c` file injected into `lsic_98.xdf` by pc98fat, with no emulator involved,
  then compiled and run inside NP2kai:

      B:\>build
      lld @link.i
      uploaded through the browser disk tool
      0 1 1 2 3 5 8 13 21 34 55 89

## Open

- **Confirm the speed fix in a browser.** The harness says 100%, and the
  arithmetic says the two clamped sleep sites were costing about half of every
  second, but nobody has yet read the 速度表示 numbers on the live page. If it is
  still slow, the two things the harness cannot see are audio (SDL's
  ScriptProcessor path) and rendering (WebGL); switching the sound board to
  音源なし isolates the first.
- **Audio latency.** Output goes through SDL's ScriptProcessor.
  [WebNP2](https://github.com/uraraworks/WebNP2) moved to an AudioWorklet fed by
  a `webnp2_audio_render` call into the core, which is the better shape.
- **EGC is unproven.** The configuration is right (`grcg.chip=3`) and nothing
  breaks, but neither test title ever switches EGC mode on — both draw through
  GRCG — so the blitter path itself has never been exercised. It needs software
  that uses it, or a synthetic test driving the registers.
- **`np2_main()` never returns**, so nothing calls `sound_recstop()` or flushes
  a mounted image on exit. The page's 保存 button covers it by hand.
- **CI is not enabled.** `ci/github-actions-wasm.yml` is a recipe only;
  `.github/workflows/` deliberately does not exist. Pages is served from the
  `main` branch root, so the demo does not depend on it.
- **Upstreaming.** The build fixes, the `bmsio_reset()` signature, the
  `fontmng.c` duplicate include and the yield change are all things upstream
  would want. None have been offered yet.

## Layout

| | |
|---|---|
| `deps/` | SDL2, libpng, zlib, vendored and built from source |
| `sdl/em/` | the Emscripten port: `main.c`, `compiler.h`, `np2wasm_api.c` |
| `web/` | the demo page and the built wasm |
| `tools/fatimg.py` | FAT12/16 image tool in Python; built the LSI-C floppy |
| `tools/pc98fat/` | the same in C, built to wasm for the page |
| `tests/wasm/` | the headless harness |
| `scripts/build-wasm.sh` | builds the emulator, bootstrapping emsdk if needed |
| `ci/` | a CI recipe, not enabled |
