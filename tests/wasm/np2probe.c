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
#include <io/iocore.h>
#include <vram/vram.h>
#include <keystat.h>

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

/* EGC state. egc_reset() leaves access=0xfff0, fgbg=0x00ff, mask=0xffff,
 * leng=0x000f, srcmask=0xffff and everything else zero, so a difference from
 * that means the guest programmed the blitter. egc_w16() also ignores writes
 * unless the EGC bit of vramop.operate is set, so that bit says whether EGC
 * mode was ever switched on. */
EMSCRIPTEN_KEEPALIVE int np2probe_egc_access(void)  { return egc.access; }
EMSCRIPTEN_KEEPALIVE int np2probe_egc_fgbg(void)    { return egc.fgbg; }
EMSCRIPTEN_KEEPALIVE int np2probe_egc_ope(void)     { return egc.ope; }
EMSCRIPTEN_KEEPALIVE int np2probe_egc_mask(void)    { return egc.mask.w; }
EMSCRIPTEN_KEEPALIVE int np2probe_egc_leng(void)    { return egc.leng; }
EMSCRIPTEN_KEEPALIVE int np2probe_egc_sft(void)     { return egc.sft; }
EMSCRIPTEN_KEEPALIVE int np2probe_vramop(void)      { return vramop.operate; }
EMSCRIPTEN_KEEPALIVE int np2probe_grcg_chip(void)   { return grcg.chip; }

/* Inject a raw PC-98 keyboard scan code. keystat_senddata() queues it the way
 * the real keyboard would; the NKEY_* values in keystat.h are those codes
 * (ESC 0x00, RETURN 0x1c, SPACE 0x34, UP 0x3a, LEFT 0x3b, RIGHT 0x3c,
 * DOWN 0x3d, F1 0x62 ...), with bit 7 set for the break. */
EMSCRIPTEN_KEEPALIVE
void np2probe_key(int code, int down)
{
	keystat_senddata((REG8)(down ? (code & 0x7f) : ((code & 0x7f) | 0x80)));
}

/* Emulated cycles executed so far. np2 accumulates into CPU_CLOCK per frame
 * slice, so this is the same expression sound_sync() uses to work out how much
 * emulated time has passed. Divide the delta by wall-clock time to get the
 * speed the machine is actually running at; the DX2 profile asks for
 * 2.4576MHz x 5 = 12.288MHz. */
EMSCRIPTEN_KEEPALIVE
double np2probe_cycles(void)
{
	return (double)CPU_CLOCK + (double)CPU_BASECLOCK - (double)CPU_REMCLOCK;
}

/* What the config asked for, for comparison. */
EMSCRIPTEN_KEEPALIVE
double np2probe_targethz(void)
{
	return (double)pccore.realclock;
}
