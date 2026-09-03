# BIOS directory

## font.rom

PC-98 font ROM image, 288,768 bytes (0x46800), matching the layout
`font/fontv98.c` expects:

    0x000000  ANK 8x8,  256 chars
    0x000800  ANK 8x16, 0x00-0x7f
    0x001000  ANK 8x16, 0x80-0xff
    0x001800  JIS kanji 16x16, 0x60 chars per ku

Built by the repository owner from the Shinonome bitmap font
(東雲フォント). It is not a dump of NEC's ROM. Without it the emulator falls
back to the ANK font built into `font/fontdata.res` and kanji render blank.

Shinonome is a BDF bitmap font family from the /efont/ Project, covering
JIS X 0201, JIS X 0208 and ISO 8859-1; its 16-dot faces are 8x16 for ANK and
16x16 for kanji, which is exactly the geometry a PC-98 font ROM wants.

- Home:      http://openlab.ring.gr.jp/efont/shinonome/
- Copyright: 2001-2004 Yasuyuki Furukawa and the /efont/ Project

The authors place Shinonome in the public domain - since Japanese law does not
allow copyright to be renounced outright, they instead declare that they will
not exercise their rights - and explicitly permit modification, conversion to
other formats, embedding and redistribution, with no warranty. Converting it
to a PC-98 font ROM image and shipping it here is covered by those terms.

## 2608_*.wav (OPNA rhythm)

Substitute waveforms for the YM2608 rhythm generator, so the rhythm channel is
not silent with no ROM registered. Taken unmodified from

    YM2608風リズム音源音色データ Ver.2.0
    Memoru (Takanori YOSHIMURA) <memoru@kisoba.info>
    https://sound.jp/jaime/fmp_top.html
    https://sound.jp/jaime/files/2608modoki2.zip

These are **not** dumped from a real YM2608 - the author built them by
collecting sounds from instruments on hand and editing them to resemble the
YM2608 rhythm set, and says outright that the waveforms differ fundamentally
from the real thing. The bundled 2608modoki2.txt is the original distribution
note; its terms (quoted) are:

    配布・転載・ソフトへの組み込み等、有償無償にかかわらずご自由にどうぞ。
    ソフトに組み込む場合や、サンプリング素材集の一部として配布する場合は
    何のタイトルに使ったかお知らせいただけるとうれしいです。

Both spellings of each file are written into MEMFS by the demo page, because
np2's own sound/rhythmc.c opens the lowercase `2608_bd.wav` while fmgen's
`OPNA::LoadRhythmSample()` opens the uppercase `2608_BD.WAV`, and MEMFS is
case-sensitive. Which one is used depends on the `USEFMGEN` setting, whose
default is on. A PC-9801-26K (YM2203) has no rhythm generator at all, so none
of this applies until the sound board is set to a YM2608-based one.

## Not included

`bios.rom`, `itf.rom`, `sound.rom` and the `2608_*.wav` rhythm samples are
NEC/Yamaha material and cannot be redistributed. None of them are required:
`bios/bios.c` embeds `itfrom.res` and falls back to it when `bios.rom` is
absent, and `BIOS_IO_EMULATION` is defined in every build. `sound.rom` only
affects the PC-9801-26K/86 sound BIOS, and the WAV files only the OPNA rhythm
channel. To dump them from real hardware, run `GETBIOS` from the floppy image
in `np2tool/`.
