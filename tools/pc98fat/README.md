# pc98fat

Read and write PC-98 disk images. Builds natively for the command line and to
its own wasm module for the demo page's "ディスクの中身" panel.

The point is to get a source file into an image and a build artifact back out
without booting anything, so you can edit on the host and compile on the
PC-98.

```sh
tools/pc98fat/build.sh          # native self test, then web/pc98fat.{js,wasm}
```

## What it handles

FAT12 and FAT16, 8.3 names, no long file names. That covers every image a
PC-98 ever wrote, and it keeps names as raw bytes, so Shift-JIS file names
survive with no code page table.

Two containers, told apart automatically:

- **A floppy** has its BPB in the first sector: 2HD is 1024 bytes per sector,
  which is why a plain FAT driver written for 512-byte sectors will not do.
- **A hard disk** has an IPL there instead, and a PC-98 partition table in
  sector 1. The geometry comes out of the partition entry - its end sector and
  head are inclusive, so sectors-per-track and heads follow - and the volume
  starts at the entry's start cylinder.

## API

Everything operates on a caller-owned buffer, so the same bytes can go
straight to a download or back into IndexedDB afterwards. Nothing is cached.

```c
int    pc98fat_open(uint8_t *image, int size);   /* autodetects the volume */
int    pc98fat_volume_offset(void);
int    pc98fat_bytes_per_sector(void);
int    pc98fat_cluster_size(void);
int    pc98fat_fat_bits(void);
int    pc98fat_cluster_count(void);
const char *pc98fat_error(void);

int    pc98fat_list(const char *dir);      /* count, or negative on error */
const char *pc98fat_listing(void);         /* "name\tsize\tattr\tcluster\n"... */

int    pc98fat_size(const char *path);
int    pc98fat_read(const char *path, uint8_t *out, int outsize);
int    pc98fat_write(const char *path, const uint8_t *data, int size);
int    pc98fat_delete(const char *path);   /* files, and empty directories */
int    pc98fat_mkdir(const char *path);
double pc98fat_free_bytes(void);
double pc98fat_total_bytes(void);
void   pc98fat_close(void);
```

Paths take `/` or `\` and walk subdirectories. Writing an existing file frees
its old chain first; writing into a full subdirectory grows it by a cluster.

## Testing

`selftest.c` runs the whole API against real images and is built and run by
`build.sh` before the wasm link, so a logic error cannot reach the browser.

The logic is also cross-checked against `tools/fatimg.py`, an independent
implementation of the same formats in Python: a file written by the C code
reads back byte-identical through the Python reader, on both a 1024-byte-sector
FAT12 floppy and a 512-byte-sector FAT16 hard disk partition, including
multi-cluster files and subdirectories.

End to end, the case this exists for: a `.c` file injected into
`web/disk/lsic_98.xdf` by this tool, with no emulator involved, then compiled
and run inside NP2kai by LSI C-86:

```
B:\>build
lld @link.i
uploaded through the browser disk tool
0 1 1 2 3 5 8 13 21 34 55 89
```
