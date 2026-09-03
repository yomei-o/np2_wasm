# BIOS directory

## font.rom

PC-98 font ROM image, 288,768 bytes (0x46800), matching the layout
`font/fontv98.c` expects:

    0x000000  ANK 8x8,  256 chars
    0x000800  ANK 8x16, 0x00-0x7f
    0x001000  ANK 8x16, 0x80-0xff
    0x001800  JIS kanji 16x16, 0x60 chars per ku

Built by the repository owner from a freely-licensed bitmap font; it is not a
dump of NEC's ROM. Without it the emulator falls back to the ANK font built
into `font/fontdata.res` and kanji render blank.

## Not included

`bios.rom`, `itf.rom`, `sound.rom` and the `2608_*.wav` rhythm samples are
NEC/Yamaha material and cannot be redistributed. None of them are required:
`bios/bios.c` embeds `itfrom.res` and falls back to it when `bios.rom` is
absent, and `BIOS_IO_EMULATION` is defined in every build. `sound.rom` only
affects the PC-9801-26K/86 sound BIOS, and the WAV files only the OPNA rhythm
channel. To dump them from real hardware, run `GETBIOS` from the floppy image
in `np2tool/`.
