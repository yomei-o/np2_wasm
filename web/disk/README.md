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

## vz_98.xdf — VZ Editor 1.6

The definitive MS-DOS text editor for the PC-98, taken unmodified from its
author's own release:

    https://github.com/vcraftjp/VZEditor  (FDImage/VZ_98.XDF)

VZ Editor was written by c.mos (兵藤嘉彦) and released in 1989; the author
open-sourced version 1.6 under the **BSD 3-Clause License** in November 2024,
disk images included. FreeDOS(98) only ships EDLIN, a line editor, so this is
what to use for real editing. `VZ.COM` is the editor; the disk also carries
EZKEY, VMAP, ZCOPY, VWX and the manuals.

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
the emulator and read back out, and `web/pc98disk.js` reproduces the result byte
for byte (`tools/fatimg.py` does the same from Python, and the two agree). One
thing had to be added: BTNPART reports writing the IPL to sector 0 but the bytes
never reach the image under np2's SCSI emulation, and with sector 0 blank the
FreeDOS(98) kernel does not offer the partition a drive letter at all. So the
IPL is written directly, from `web/bios/pc98_ipl.bin` - that is BTNPART.MBR off
the FreeDOS(98) floppy, which BTNPART.TXT places in the public domain.

Writes the guest makes go to MEMFS and vanish on reload, so each mounted image
has a 保存 button that copies it back into the library, and a DL button that
downloads the current contents.
