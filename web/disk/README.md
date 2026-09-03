# Disk images

Everything here is redistributable, and none of it is a dump of copyrighted
ROM or commercial software.

## fd98_2hd.img — FreeDOS(98) boot floppy

FreeDOS(98) bootable 2HD (1.2MB) floppy, taken unmodified from

    https://github.com/lpproj/fdkernel/releases/tag/test-20220120-cherrypick
    (fd98_2hd144_20220123.zip -> fd98_2hd.img, 1,261,568 bytes, 2022-01-23)

FreeDOS(98) is lpproj's port of FreeDOS to the NEC PC-9801/9821 series. Plain
FreeDOS is built for the IBM PC/AT and does not boot on a PC-98, so this port
is what the browser demo runs.

- Kernel and COMMAND.COM source: https://github.com/lpproj/fdkernel
- FreeCOM (DBCS) source:         https://github.com/lpproj/freecom_dbcs2
- Distribution page:             http://bauxite.sakura.ne.jp/software/dos/freedos.htm
- FreeDOS project:               http://www.freedos.org/

The FreeDOS kernel and FreeCOM are licensed under the GNU GPL v2 or later; the
image is redistributed here under those terms, with the corresponding source
available at the repositories above.

At the FreeDOS(98) boot menu, option 2 (the 80286 XMS driver) matches the
PC-9801DX-class machine the demo is configured as. Option 3 adds the 386 XMS
driver and the IDE CD-ROM driver, and F5 skips CONFIG.SYS entirely.

Notable tools on it: `BTNPART.EXE` partitions a PC-98 hard disk, `FDFORMAT.EXE`
formats floppies, `SYS.COM` makes a drive bootable, `EDLIN.EXE` is a line
editor, and `DEBUG.COM` and `MEM.EXE` are there for poking around.

## tools_98.xdf — VZ Editor, LHA, UnZip, Zip

The editor and the archivers on one disk, since the machine only has two
floppy drives.

### VZ Editor 1.6

The definitive MS-DOS text editor for the PC-98. Its files are taken
unmodified from the author's own release image:

    https://github.com/vcraftjp/VZEditor  (FDImage/VZ_98.XDF)

VZ Editor was written by c.mos (兵藤嘉彦) and released in 1989; the author
open-sourced version 1.6 under the **BSD 3-Clause License** in November 2024,
disk images included. FreeDOS(98) only ships EDLIN, a line editor, so this is
what to use for real editing. `VZ.COM` is the editor; `EZKEY`, `VMAP`, `ZCOPY`,
`VWX` and the manuals are here too, along with the J31, MISC, WIN, SRC and
30BIOS directories exactly as upstream has them.

### LHA 2.55 — LZH

    LHA ver 2.55 暫定公開版 (1992-11-15), 吉崎栄泰
    https://www.vector.co.jp/soft/dos/util/se002413.html

Its READ.ME says 「転載は自由です」, and LHA.DOC section 4
（使用・再配布・移植・改良について）sets the conditions:

    本プログラムは、著作権を放棄していないいわゆる「フリーソフトウェア」です。
    以下の条件に従って、自由に使用していただいてかまいません。
      1. 著作権表示を変更しないこと。
      2. 同梱 LHA.DOC を一緒に配布すること。

So `LHA.DOC` ships next to `LHA.EXE` here, unmodified, as condition 2
requires, with `LHAREAD.ME` (its READ.ME) alongside.

The distribution is a self-extracting LZH. Rather than fight a Python LZH
reader over it, it was extracted the obvious way: put `lha255.exe` on a blank
floppy, boot FreeDOS(98) in the headless harness, and let DOS unpack its own
archive.

### Info-ZIP UnZip 5.52 and Zip 2.32 — ZIP

    unz552x3.exe and zip232x.zip, Info-ZIP
    https://infozip.sourceforge.net/

**16-bit** builds, which matters: the 32-bit executables in those same
distributions are djgpp and need a 386 and a DPMI server, so they cannot run
on the PC-9801DX-class machine the demo boots as. `UNZIP.EXE` is the 16-bit
unzip from `unz552x3.exe`; `ZIP16.EXE` and `ZIP16SM.EXE` are the two 16-bit
Zip builds from `zip232x.zip`. Per its own README.DOS, `ZIP16.EXE` wants about
455KB of contiguous free DOS memory and `ZIP16SM.EXE` (the SMALL_MEM variant)
about 322KB - on a 640KB machine, reach for the latter.

The Info-ZIP licence grants permission "to use this software for any purpose,
including commercial applications, and to alter it and redistribute it freely"
subject to keeping the copyright, definition and disclaimer, not
misrepresenting the origin, and marking altered versions. The binaries here
are unaltered and `INFOZIP.LIC` is the licence text as shipped.

### Trying it

`TEST.ZIP` is a 143-byte archive for checking the tools work. Put this disk in
FDD2, boot, and:

    B:
    UNZIP TEST.ZIP        →  inflating: ./TEST.TXT
    TYPE TEST.TXT         →  hello from a zip on a PC-98
    LHA A T.LZH TEST.TXT  →  Creating archive : t.lzh  ==> 100% TEST.TXT
    LHA L T.LZH           →  TEST.TXT  29  29  100.0%  -lh0-
    ZIP16SM T.ZIP TEST.TXT

which is exactly the run that verified this image. About 107KB is left free
for working space.

## lsic_98.xdf — LSI C-86 3.30c 試食版

A C compiler for MS-DOS, built here from the trial-version archive:

    https://archive.org/details/lsic330c
    (also on Vector: https://www.vector.co.jp/soft/maker/lsi/se001169.html)

LSI C-86 was LSI Japan's MS-DOS self compiler. The 試食版 ("tasting version")
is the product minus the ability to compile anything but the small model, and
its release note states plainly:

    本パッケージは自由に配布できます。ただ、配布される人は配布先での
    サポート責任を持っていてくださらなくてもかまいません。

That is, free redistribution with no support obligation - and explicitly
including redistribution over networks or attached to a magazine. Do not
contact LSI Japan about it.

The image is laid out the way `_LCC` expects, under `\LSIC86`:

    \LSIC86\BIN       lcc, cpp, cf, cg86, r86, lld, make, oar, prof, libr...
    \LSIC86\INCLUDE   headers
    \LSIC86\LIB       libraries, and LIB\S with the small-model objects
    \LSIC86\SRC       library and tool sources
    \HELLO.C          a test program
    \TEST.BAT         compiles and runs HELLO.C

`_LCC` is the one file changed from upstream: its `-X`, `-L` and `-I` paths had
the drive letter dropped (`A:\LSIC86\BIN` became `\LSIC86\BIN`) so the compiler
works whether the tree sits on the floppy or gets copied to a hard disk.

To try it, put this in FDD2, boot, and:

    B:
    TEST

which prints `hello from LSI C-86 on NP2kai wasm` and a small times table.

## Hard disk images

Not shipped - the demo makes them. "HDDイメージ作成" builds a `.hdn` SCSI image
(a flat RaSCSI image for the PC-9801-55/92: no header, 512-byte sectors, 25
sectors per track, 8 heads) with a PC-98 partition table and an empty FAT16
volume already in place, so FreeDOS(98) gives it a drive letter immediately -
no BTNPART, no FORMAT.

The layout was not guessed. A blank image was partitioned by BTNPART.EXE inside
the emulator and read back out, and `tools/pc98fat/pc98fat.c` reproduces the
result byte for byte (`tools/fatimg.py` does the same from Python, and the two
agree). One
thing had to be added: BTNPART reports writing the IPL to sector 0 but the bytes
never reach the image under np2's SCSI emulation, and with sector 0 blank the
FreeDOS(98) kernel does not offer the partition a drive letter at all. So the
IPL is written directly, from `web/bios/pc98_ipl.bin` - that is BTNPART.MBR off
the FreeDOS(98) floppy, which BTNPART.TXT places in the public domain.

Writes the guest makes go to MEMFS and vanish on reload, so each mounted image
has a 保存 button that copies it back into the library, and a DL button that
downloads the current contents.
