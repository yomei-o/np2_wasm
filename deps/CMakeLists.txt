# Vendored third-party libraries.
#
# The Emscripten build used to rely on emscripten-ports (-s USE_SDL=2,
# -s USE_LIBPNG=1), which downloads SDL2, libpng and zlib from the network on
# the first build. Everything needed is vendored under deps/ instead, so a
# clone of this repository plus the Emscripten SDK is all it takes to produce
# a wasm build.
#
# Versions match the emscripten-ports revisions they replace:
#   SDL2   release-2.32.10   (deps/SDL2,   zlib license)
#   libpng 1.6.58            (deps/libpng, libpng/zlib license)
#   zlib   1.3.2             (deps/zlib,   zlib license)
#
# The libpng pnglibconf.h and the zlib zconf.h are the configurations
# emscripten-ports generates for wasm, kept verbatim.

# ---------------------------------------------------------------- zlib 1.3.2
add_library(np2kai_zlib STATIC
	zlib/adler32.c
	zlib/compress.c
	zlib/crc32.c
	zlib/deflate.c
	zlib/gzclose.c
	zlib/gzlib.c
	zlib/gzread.c
	zlib/gzwrite.c
	zlib/infback.c
	zlib/inffast.c
	zlib/inflate.c
	zlib/inftrees.c
	zlib/trees.c
	zlib/uncompr.c
	zlib/zutil.c
)
target_include_directories(np2kai_zlib PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/zlib")
target_compile_options(np2kai_zlib PRIVATE -Wno-deprecated-non-prototype)
add_library(ZLIB::ZLIB ALIAS np2kai_zlib)

# ------------------------------------------------------------- libpng 1.6.58
add_library(np2kai_png STATIC
	libpng/png.c
	libpng/pngerror.c
	libpng/pngget.c
	libpng/pngmem.c
	libpng/pngpread.c
	libpng/pngread.c
	libpng/pngrio.c
	libpng/pngrtran.c
	libpng/pngrutil.c
	libpng/pngset.c
	libpng/pngtrans.c
	libpng/pngwio.c
	libpng/pngwrite.c
	libpng/pngwtran.c
	libpng/pngwutil.c
)
target_include_directories(np2kai_png PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/libpng")
target_link_libraries(np2kai_png PUBLIC np2kai_zlib)
add_library(PNG::PNG ALIAS np2kai_png)

# --------------------------------------------------- SDL2 release-2.32.10
# Source list and flags follow emscripten-ports' tools/ports/sdl2.py, which is
# the only combination of SDL2 backends that builds for wasm.
set(np2kai_SDL2_sources
	SDL.c SDL_assert.c SDL_dataqueue.c SDL_error.c SDL_guid.c SDL_hints.c
	SDL_list.c SDL_log.c SDL_utils.c
	atomic/SDL_atomic.c atomic/SDL_spinlock.c
	audio/SDL_audio.c audio/SDL_audiocvt.c audio/SDL_audiodev.c
	audio/SDL_audiotypecvt.c audio/SDL_mixer.c audio/SDL_wave.c
	audio/disk/SDL_diskaudio.c audio/dummy/SDL_dummyaudio.c
	audio/emscripten/SDL_emscriptenaudio.c
	cpuinfo/SDL_cpuinfo.c
	dynapi/SDL_dynapi.c
	events/SDL_clipboardevents.c events/SDL_displayevents.c
	events/SDL_dropevents.c events/SDL_events.c events/SDL_gesture.c
	events/SDL_keyboard.c events/SDL_keysym_to_scancode.c
	events/SDL_scancode_tables.c events/SDL_mouse.c events/SDL_quit.c
	events/SDL_touch.c events/SDL_windowevents.c
	file/SDL_rwops.c
	filesystem/emscripten/SDL_sysfilesystem.c
	haptic/SDL_haptic.c haptic/dummy/SDL_syshaptic.c
	hidapi/SDL_hidapi.c
	joystick/controller_type.c joystick/SDL_gamecontroller.c
	joystick/SDL_joystick.c joystick/SDL_steam_virtual_gamepad.c
	joystick/emscripten/SDL_sysjoystick.c
	loadso/dlopen/SDL_sysloadso.c
	locale/SDL_locale.c locale/emscripten/SDL_syslocale.c
	main/dummy/SDL_dummy_main.c
	misc/SDL_url.c misc/emscripten/SDL_sysurl.c
	power/SDL_power.c power/emscripten/SDL_syspower.c
	render/SDL_d3dmath.c render/SDL_render.c render/SDL_yuv_sw.c
	render/direct3d/SDL_render_d3d.c render/direct3d11/SDL_render_d3d11.c
	render/opengl/SDL_render_gl.c render/opengl/SDL_shaders_gl.c
	render/opengles/SDL_render_gles.c
	render/opengles2/SDL_render_gles2.c render/opengles2/SDL_shaders_gles2.c
	render/psp/SDL_render_psp.c
	render/software/SDL_blendfillrect.c render/software/SDL_blendline.c
	render/software/SDL_blendpoint.c render/software/SDL_drawline.c
	render/software/SDL_drawpoint.c render/software/SDL_render_sw.c
	render/software/SDL_rotate.c render/software/SDL_triangle.c
	sensor/SDL_sensor.c sensor/dummy/SDL_dummysensor.c
	stdlib/SDL_crc16.c stdlib/SDL_crc32.c stdlib/SDL_getenv.c
	stdlib/SDL_iconv.c stdlib/SDL_malloc.c stdlib/SDL_qsort.c
	stdlib/SDL_stdlib.c stdlib/SDL_string.c stdlib/SDL_strtokr.c
	thread/SDL_thread.c
	thread/generic/SDL_syscond.c thread/generic/SDL_sysmutex.c
	thread/generic/SDL_syssem.c thread/generic/SDL_systhread.c
	thread/generic/SDL_systls.c
	timer/SDL_timer.c timer/unix/SDL_systimer.c
	video/SDL_RLEaccel.c video/SDL_blit.c video/SDL_blit_0.c
	video/SDL_blit_1.c video/SDL_blit_A.c video/SDL_blit_N.c
	video/SDL_blit_auto.c video/SDL_blit_copy.c video/SDL_blit_slow.c
	video/SDL_bmp.c video/SDL_clipboard.c video/SDL_egl.c
	video/SDL_fillrect.c video/SDL_pixels.c video/SDL_rect.c
	video/SDL_shape.c video/SDL_stretch.c video/SDL_surface.c
	video/SDL_video.c video/SDL_yuv.c
	video/dummy/SDL_nullevents.c video/dummy/SDL_nullframebuffer.c
	video/dummy/SDL_nullvideo.c
	video/emscripten/SDL_emscriptenevents.c
	video/emscripten/SDL_emscriptenframebuffer.c
	video/emscripten/SDL_emscriptenmouse.c
	video/emscripten/SDL_emscriptenopengles.c
	video/emscripten/SDL_emscriptenvideo.c
	video/yuv2rgb/yuv_rgb_std.c
)
list(TRANSFORM np2kai_SDL2_sources PREPEND "${CMAKE_CURRENT_SOURCE_DIR}/SDL2/src/")

# SDL2's own sources reach for "../../include/SDL_foo.h", so its headers have
# to stay where upstream puts them. compiler_base.h on the other hand asks for
# <SDL2/SDL.h>, which is how the headers are laid out once installed. Mirror
# them into the build tree under an SDL2/ directory to satisfy both.
set(np2kai_SDL2_include_mirror "${CMAKE_CURRENT_BINARY_DIR}/include")
file(GLOB np2kai_SDL2_headers "${CMAKE_CURRENT_SOURCE_DIR}/SDL2/include/*.h")
file(COPY ${np2kai_SDL2_headers} DESTINATION "${np2kai_SDL2_include_mirror}/SDL2")

add_library(np2kai_SDL2 STATIC ${np2kai_SDL2_sources})
target_include_directories(np2kai_SDL2 PUBLIC
	"${CMAKE_CURRENT_SOURCE_DIR}/SDL2/include"
	"${np2kai_SDL2_include_mirror}"
)
# -s USE_SDL=0 keeps emcc from putting its own bundled SDL1 headers in front of
# ours; -fwrapv-pointer is what emscripten-ports uses for SDL 2.32.x.
target_compile_options(np2kai_SDL2 PUBLIC "SHELL:-s USE_SDL=0")
target_compile_options(np2kai_SDL2 PRIVATE -fwrapv-pointer)
# SDL2 reaches for Module['createContext'] and eglGetProcAddress() from JS.
# FS and callMain are for the page shell (mounting disk images, restarting).
target_link_options(np2kai_SDL2 INTERFACE
	"SHELL:-s USE_SDL=0"
	"SHELL:-s GL_ENABLE_GET_PROC_ADDRESS=1"
	"SHELL:-s EXPORTED_RUNTIME_METHODS=['createContext','FS','callMain']"
)
add_library(SDL2::SDL2 ALIAS np2kai_SDL2)
