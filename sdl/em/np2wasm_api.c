/*
 * Small API the hosting page can call into.
 *
 * Emscripten-only. The page has no other way to tell "the emulator is running
 * slowly" from "the emulator is running but the browser is not painting", and
 * without a number for the speed there is nothing to compare a change against.
 */

#include <compiler.h>

#if defined(EMSCRIPTEN) && !defined(__LIBRETRO__)

#include <cpucore.h>
#include <pccore.h>
#include <emscripten.h>

/*
 * Hand the browser a turn, without the 4ms floor.
 *
 * The emulation loop has to yield once per frame or the page freezes, and it
 * used emscripten_sleep(0) to do it. That unwinds through setTimeout, which
 * browsers clamp to 4ms once the callback is nested - so at the ~66 yields a
 * second the loop actually performs, a quarter of every second was spent
 * sitting in a timer. node does not clamp, which is why this only ever showed
 * up in a browser.
 *
 * A MessageChannel round trip is a task like any other, so the browser still
 * gets its rendering opportunity between turns, but it carries no minimum
 * delay. This is the same trick React's scheduler uses.
 */
EM_ASYNC_JS(void, np2wasm_yield, (void), {
	await new Promise(function (resolve) {
		var ch = Module.np2yieldChannel;
		if (!ch) {
			ch = Module.np2yieldChannel = new MessageChannel();
			ch.port1.onmessage = function () {
				var fn = Module.np2yieldResolve;
				Module.np2yieldResolve = null;
				if (fn) fn();
			};
			if (ch.port1.start) ch.port1.start();
		}
		Module.np2yieldResolve = resolve;
		ch.port2.postMessage(0);
	});
});

/*
 * Emulated cycles executed so far. np2 accumulates into CPU_CLOCK a frame
 * slice at a time; this is the same expression sound_sync() uses to work out
 * how much emulated time has passed. Sample it twice and divide by the wall
 * clock to get the speed the machine is actually reaching.
 *
 * Returned as a double because the counter passes 2^32 in a few minutes.
 */
EMSCRIPTEN_KEEPALIVE
double np2wasm_cycles(void)
{
	return (double)CPU_CLOCK + (double)CPU_BASECLOCK - (double)CPU_REMCLOCK;
}

/* The clock the config asked for, in Hz: clk_base * clk_mult. */
EMSCRIPTEN_KEEPALIVE
double np2wasm_targethz(void)
{
	return (double)pccore.realclock;
}

/* Which sound board is installed, as the SOUNDID_* value. 0 means none, so
 * the page can say whether the audio path is even in play. */
EMSCRIPTEN_KEEPALIVE
int np2wasm_soundid(void)
{
	return (int)pccore.sound;
}

#endif	/* EMSCRIPTEN && !__LIBRETRO__ */
