#ifndef COMPILER_H
#define COMPILER_H

#include "compiler_base.h"

#include	<sys/param.h>
#include	<stdio.h>
#include	<stdlib.h>
#include	<setjmp.h>
#include	<stdarg.h>
#include	<stddef.h>
#include	<string.h>
#include	<unistd.h>
#include	<assert.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

/* np2 can record the mixed sound output to a WAV file; the windows,
 * wx and x ports enable it and the SDL ports never did. */
#define	SUPPORT_WAVEREC

#define	msgbox(title, msg)

#define	GETTICK()			SDL_GetTicks()
#define	__ASSERT(s)
#undef SPRINTF
#define	SPRINTF				sprintf
#undef STRLEN
#define	STRLEN				strlen
#define	SDL_main			main

#include "common/milstr.h"
#include	"trace.h"

#define EMSCRIPTEN_DIR "/emulator/np2kai/"

#endif  // COMPILER_H

