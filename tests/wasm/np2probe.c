/*
 * Test-only probes for the headless wasm harness (tests/wasm/runtest.js).
 *
 * Not part of any shipped target: linked in only by the harness, which needs a
 * way to look at emulated memory and the rendered screen from JS to tell "the
 * emulator is running" from "the emulator started and did nothing".
 */

#include <compiler.h>
#include <cpucore.h>
#include <pccore.h>
#include <scrnmng.h>
#include <sound/sound.h>
#include <sound/rhythm.h>
#include <dosio.h>

/* Text VRAM: character codes at even offsets from 0xa0000, attributes from
 * 0xa2000. See vram/maketext.c. */
EMSCRIPTEN_KEEPALIVE
unsigned char *np2probe_textvram(void)
{
	return mem + 0xa0000;
}

EMSCRIPTEN_KEEPALIVE
unsigned char *np2probe_mem(void)
{
	return mem;
}

/* scrnmng.pc98surf holds the composited PC-98 screen - text, graphics, EGC
 * results and palette all applied - in scrnmng.bpp format, which is 16
 * (RGB565) for the Emscripten SDL2 build. This is what scrnmng_surflock()
 * hands the drawing code. */
EMSCRIPTEN_KEEPALIVE
unsigned char *np2probe_screen(void)
{
	if (!scrnmng.pc98surf) {
		return NULL;
	}
	return (unsigned char *)scrnmng.pc98surf->pixels;
}

EMSCRIPTEN_KEEPALIVE int np2probe_screen_width(void)  { return scrnmng.width; }
EMSCRIPTEN_KEEPALIVE int np2probe_screen_height(void) { return scrnmng.height; }
EMSCRIPTEN_KEEPALIVE int np2probe_screen_bpp(void)    { return scrnmng.bpp; }
EMSCRIPTEN_KEEPALIVE int np2probe_screen_pitch(void)
{
	return scrnmng.pc98surf ? scrnmng.pc98surf->pitch : 0;
}

/* np2 mixes sound from the device write paths (sound_sync()), not from the
 * audio callback, so recording works with no audio device at all. */
EMSCRIPTEN_KEEPALIVE
int np2probe_recstart(const char *path)
{
	return sound_recstart(path) == SUCCESS ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
void np2probe_recstop(void)
{
	sound_recstop();
}

EMSCRIPTEN_KEEPALIVE
int np2probe_isrecording(void)
{
	return sound_isrecording() ? 1 : 0;
}

/* Bit per rhythm track whose 2608_*.wav loaded (0x3f = all six). Only the
 * OPNA-based boards use these; a PC-9801-26K is OPN and has no rhythm. */
EMSCRIPTEN_KEEPALIVE
int np2probe_rhythmcaps(void)
{
	return (int)rhythm_getcaps();
}

/* Where np2 looks for BIOS-directory files, and whether it can actually open
 * one. getbiospath() joins np2cfg.biospath, which the Emscripten branch of
 * np2_main() leaves as whatever datadir gives it. */
EMSCRIPTEN_KEEPALIVE
const char *np2probe_biosresolve(const char *fname)
{
	static OEMCHAR path[MAX_PATH];
	getbiospath(path, fname, NELEMENTS(path));
	return path;
}

EMSCRIPTEN_KEEPALIVE
int np2probe_canopen(const char *fname)
{
	OEMCHAR path[MAX_PATH];
	FILEH fh;

	getbiospath(path, fname, NELEMENTS(path));
	fh = file_open_rb(path);
	if (fh == FILEH_INVALID) {
		return 0;
	}
	file_close(fh);
	return 1;
}
