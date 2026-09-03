#ifndef NP2_EM_NP2WASM_API_H
#define NP2_EM_NP2WASM_API_H

#if defined(EMSCRIPTEN) && !defined(__LIBRETRO__)

#ifdef __cplusplus
extern "C" {
#endif

/* Yield to the browser without setTimeout's 4ms floor. See np2wasm_api.c. */
void np2wasm_yield(void);

/* Reported to the hosting page. */
double np2wasm_cycles(void);
double np2wasm_targethz(void);
int np2wasm_soundid(void);

#ifdef __cplusplus
}
#endif

#endif	/* EMSCRIPTEN && !__LIBRETRO__ */

#endif	/* NP2_EM_NP2WASM_API_H */
