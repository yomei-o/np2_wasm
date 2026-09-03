# Disk images

## fd98_2hd.img

FreeDOS(98) bootable 2HD (1.2MB) floppy image, taken unmodified from

  https://github.com/lpproj/fdkernel/releases/tag/test-20220120-cherrypick
  (fd98_2hd144_20220123.zip -> fd98_2hd.img, 1,261,568 bytes, 2022-01-23)

FreeDOS(98) is lpproj's port of FreeDOS to the NEC PC-9801/9821 series. Plain
FreeDOS is built for the IBM PC/AT and does not boot on a PC-98, so this port
is what the browser demo runs.

- Kernel and COMMAND.COM source: https://github.com/lpproj/fdkernel
- Distribution page:             http://bauxite.sakura.ne.jp/software/dos/freedos.htm
- FreeDOS project:               http://www.freedos.org/

The FreeDOS kernel and FreeCOM are licensed under the GNU GPL v2 or later; the
image is redistributed here under those terms, with the corresponding source
available at the repository above.

At the FreeDOS(98) boot menu, option 2 (the 80286 XMS driver) matches the
PC-9801DX-class machine the demo is configured as. Option 3 adds the 386 XMS
driver and the IDE CD-ROM driver, and F5 skips CONFIG.SYS entirely.
