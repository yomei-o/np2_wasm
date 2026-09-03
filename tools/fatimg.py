#!/usr/bin/env python3
"""PC-98 disk image tool: FAT12/FAT16 create, list, add, extract.

Covers the two containers the wasm demo needs:

  2HD floppy   1024-byte sectors, 8 sectors/track, 77 cylinders x 2 heads
               = 1232 sectors = 1,261,568 bytes, FAT12. This is what np2
               reads as .xdf / .hdm / a raw .img, and what the FreeDOS(98)
               boot floppy is.

  .hdn SCSI    RaSCSI flat image for the PC-9801-55/92: no header at all,
               512-byte sectors, 25 sectors/track, 8 heads (see
               newdisk_hdn() in fdd/newdisk.c). A PC-98 partition table
               lives in sector 1 and each partition holds a FAT16 volume.

Usage:
  fatimg.py ls        <image> [--offset N]
  fatimg.py extract   <image> <name> <out> [--offset N]
  fatimg.py mkfd      <image> [--label NAME]
  fatimg.py add       <image> <src>... [--dir DOSDIR] [--offset N]
  fatimg.py mkhdn     <image> --mb 100 [--label NAME]
  fatimg.py info      <image>
"""

import argparse
import os
import struct
import sys

SEC_2HD = 1024
FD_2HD_SECTORS = 1232          # 77 cylinders * 2 heads * 8 sectors

HDN_SECTOR = 512
HDN_SECTORS_PER_TRACK = 25
HDN_HEADS = 8


# --------------------------------------------------------------------------
# BPB / directory helpers
# --------------------------------------------------------------------------

class Bpb:
    def __init__(self, image, offset=0):
        self.image = image
        self.offset = offset
        b = image[offset:offset + 512]
        self.bps = struct.unpack_from('<H', b, 11)[0]
        self.spc = b[13]
        self.reserved = struct.unpack_from('<H', b, 14)[0]
        self.nfats = b[16]
        self.nroot = struct.unpack_from('<H', b, 17)[0]
        self.total16 = struct.unpack_from('<H', b, 19)[0]
        self.media = b[21]
        self.spf = struct.unpack_from('<H', b, 22)[0]
        self.spt = struct.unpack_from('<H', b, 24)[0]
        self.heads = struct.unpack_from('<H', b, 26)[0]
        self.hidden = struct.unpack_from('<I', b, 28)[0]
        self.total32 = struct.unpack_from('<I', b, 32)[0]
        self.total = self.total16 or self.total32
        if not self.bps:
            raise ValueError('no FAT BPB at offset %d' % offset)

    @property
    def fat_start(self):
        return self.offset + self.reserved * self.bps

    @property
    def root_start(self):
        return self.fat_start + self.nfats * self.spf * self.bps

    @property
    def data_start(self):
        return self.root_start + ((self.nroot * 32 + self.bps - 1) // self.bps) * self.bps

    @property
    def clusters(self):
        data_sectors = self.total - (self.data_start - self.offset) // self.bps
        return data_sectors // self.spc

    @property
    def fat_bits(self):
        return 12 if self.clusters < 4085 else 16

    def cluster_offset(self, cl):
        return self.data_start + (cl - 2) * self.spc * self.bps

    def describe(self):
        return ('bps=%d spc=%d reserved=%d fats=%d root=%d total=%d media=0x%02x '
                'spf=%d spt=%d heads=%d clusters=%d FAT%d'
                % (self.bps, self.spc, self.reserved, self.nfats, self.nroot,
                   self.total, self.media, self.spf, self.spt, self.heads,
                   self.clusters, self.fat_bits))


def fat_get(image, bpb, cl):
    if bpb.fat_bits == 12:
        i = bpb.fat_start + cl + (cl >> 1)
        v = struct.unpack_from('<H', image, i)[0]
        return (v >> 4) if (cl & 1) else (v & 0x0fff)
    return struct.unpack_from('<H', image, bpb.fat_start + cl * 2)[0]


def fat_set(image, bpb, cl, value):
    for n in range(bpb.nfats):
        base = bpb.fat_start + n * bpb.spf * bpb.bps
        if bpb.fat_bits == 12:
            i = base + cl + (cl >> 1)
            v = struct.unpack_from('<H', image, i)[0]
            v = ((value << 4) | (v & 0x000f)) if (cl & 1) else ((v & 0xf000) | value)
            struct.pack_into('<H', image, i, v)
        else:
            struct.pack_into('<H', image, base + cl * 2, value)


def fat_eoc(bpb):
    return 0xfff if bpb.fat_bits == 12 else 0xffff


def chain(image, bpb, start):
    out = []
    cl = start
    limit = 0xff0 if bpb.fat_bits == 12 else 0xfff0
    while 2 <= cl < limit and len(out) <= bpb.clusters:
        out.append(cl)
        cl = fat_get(image, bpb, cl)
    return out


def free_clusters(image, bpb, count):
    out = []
    for cl in range(2, bpb.clusters + 2):
        if fat_get(image, bpb, cl) == 0:
            out.append(cl)
            if len(out) == count:
                return out
    raise IOError('not enough free space (need %d clusters, found %d)'
                  % (count, len(out)))


def dos_name(name):
    name = name.upper()
    stem, _, ext = name.rpartition('.') if '.' in name else (name, '', '')
    if not stem:
        stem, ext = name, ''
    stem = ''.join(c for c in stem if c not in ' ')[:8]
    ext = ext[:3]
    return stem.ljust(8).encode('cp932') + ext.ljust(3).encode('cp932')


def read_dir(image, bpb, start, sectors=None):
    """Yield (index_offset, entry) over a directory region."""
    if sectors is None:                     # root directory
        off, count = bpb.root_start, bpb.nroot
    else:
        off, count = start, sectors
    for i in range(count):
        p = off + i * 32
        yield p, image[p:p + 32]


def iter_root(image, bpb):
    for p, e in read_dir(image, bpb, None):
        if e[0] == 0x00:
            return
        if e[0] == 0xe5 or (e[11] & 0x0f) == 0x0f:
            continue
        yield p, e


def entry_name(e):
    stem = e[0:8].decode('cp932', 'replace').rstrip()
    ext = e[8:11].decode('cp932', 'replace').rstrip()
    return stem + ('.' + ext if ext else '')


# --------------------------------------------------------------------------
# listing / extracting
# --------------------------------------------------------------------------

def cmd_ls(args):
    image = bytearray(open(args.image, 'rb').read())
    bpb = Bpb(image, args.offset)
    print(bpb.describe())
    for _, e in iter_root(image, bpb):
        attr = e[11]
        size = struct.unpack_from('<I', e, 28)[0]
        kind = 'DIR' if attr & 0x10 else ('VOL' if attr & 0x08 else '')
        print('  %-14s %9d %s' % (entry_name(e), size, kind))


def cmd_extract(args):
    image = bytearray(open(args.image, 'rb').read())
    bpb = Bpb(image, args.offset)
    for _, e in iter_root(image, bpb):
        if entry_name(e).upper() != args.name.upper():
            continue
        start = struct.unpack_from('<H', e, 26)[0]
        size = struct.unpack_from('<I', e, 28)[0]
        buf = b''
        for cl in chain(image, bpb, start):
            o = bpb.cluster_offset(cl)
            buf += bytes(image[o:o + bpb.spc * bpb.bps])
        open(args.out, 'wb').write(buf[:size])
        print('%s -> %s (%d bytes)' % (args.name, args.out, size))
        return
    sys.exit('not found: %s' % args.name)


# --------------------------------------------------------------------------
# creating
# --------------------------------------------------------------------------

def build_bpb(bps, spc, reserved, nfats, nroot, total, media, spf, spt, heads,
              hidden=0, label='NP2KAI', fat16=False, oem=b'NP2KAI  '):
    b = bytearray(bps)
    b[0:3] = b'\xeb\x00\x90'                # a jump, so DOS accepts the BPB
    b[3:11] = oem.ljust(8)[:8]
    struct.pack_into('<H', b, 11, bps)
    b[13] = spc
    struct.pack_into('<H', b, 14, reserved)
    b[16] = nfats
    struct.pack_into('<H', b, 17, nroot)
    struct.pack_into('<H', b, 19, 0 if total > 0xffff else total)
    b[21] = media
    struct.pack_into('<H', b, 22, spf)
    struct.pack_into('<H', b, 24, spt)
    struct.pack_into('<H', b, 26, heads)
    struct.pack_into('<I', b, 28, hidden)
    struct.pack_into('<I', b, 32, total if total > 0xffff else 0)
    b[36] = 0x80 if fat16 else 0x00          # BIOS drive: 0x80 = first HDD
    b[38] = 0x29                            # extended boot signature
    struct.pack_into('<I', b, 39, 0x12345678)
    b[43:54] = label.upper().ljust(11).encode('cp932')[:11]
    b[54:62] = (b'FAT16   ' if fat16 else b'FAT12   ')
    b[bps - 2:bps] = b'\x55\xaa'
    return b


def init_fat(image, bpb, media):
    """Write the two reserved FAT entries into every copy."""
    for n in range(bpb.nfats):
        base = bpb.fat_start + n * bpb.spf * bpb.bps
        if bpb.fat_bits == 12:
            image[base:base + 3] = bytes([media, 0xff, 0xff])
        else:
            image[base:base + 4] = bytes([media, 0xff, 0xff, 0xff])


def set_label(image, bpb, label):
    p = bpb.root_start
    image[p:p + 11] = label.upper().ljust(11).encode('cp932')[:11]
    image[p + 11] = 0x08


def cmd_mkfd(args):
    """A blank PC-98 2HD (1.2MB) FAT12 floppy, same shape as the FreeDOS one."""
    total = FD_2HD_SECTORS
    bpb_bytes = build_bpb(bps=SEC_2HD, spc=1, reserved=1, nfats=2, nroot=192,
                          total=total, media=0xfe, spf=2, spt=8, heads=2,
                          label=args.label)
    image = bytearray(SEC_2HD * total)
    image[0:SEC_2HD] = bpb_bytes
    bpb = Bpb(image, 0)
    init_fat(image, bpb, 0xfe)
    set_label(image, bpb, args.label)
    open(args.image, 'wb').write(image)
    print('%s: %d bytes, %s' % (args.image, len(image), bpb.describe()))


def fat16_geometry(total_sectors):
    """Pick a cluster size that keeps the count inside FAT16 and above FAT12."""
    for spc in (4, 8, 16, 32, 64):
        # rough: clusters must land in (4084, 65525)
        clusters = total_sectors // spc
        if 4085 < clusters < 65525:
            spf = ((clusters + 2) * 2 + 511) // 512
            return spc, spf
    raise ValueError('no usable cluster size for %d sectors' % total_sectors)


# PC-98 partition table: sector 1 holds up to 16 entries of 32 bytes. The
# layout below was read back out of an image that FreeDOS(98)'s BTNPART.EXE
# had just partitioned, rather than guessed:
#
#   +0   mid          0xa1 (bootable DOS partition)
#   +1   sid          0xa1
#   +2   dummy1, dummy2
#   +4   ipl sector, ipl head, ipl cylinder (LE16)
#   +8   start sector, start head, start cylinder (LE16)
#   +12  end sector, end head, end cylinder (LE16)   - all inclusive
#   +16  name, 16 bytes, Shift-JIS, space padded
def pc98_partition_entry(start_cyl, end_cyl, heads, spt, name):
    e = bytearray(32)
    e[0] = 0xa1
    e[1] = 0xa1
    struct.pack_into('<BBH', e, 4, 0, 0, start_cyl)          # IPL location
    struct.pack_into('<BBH', e, 8, 0, 0, start_cyl)          # first sector
    struct.pack_into('<BBH', e, 12, spt - 1, heads - 1, end_cyl)
    e[16:32] = name.ljust(16).encode('cp932')[:16]
    return e


def cmd_mkhdn(args):
    """A PC-98 SCSI .hdn holding one FAT16 partition over the whole disk.

    Matches what BTNPART.EXE produces, with one difference: the IPL in sector
    0 is written here. BTNPART reports writing it but the bytes never reach
    the image under np2's SCSI emulation, and without an IPL the FreeDOS(98)
    kernel does not offer the partition a drive letter at all.
    """
    mb = args.mb
    track = HDN_SECTOR * HDN_SECTORS_PER_TRACK * HDN_HEADS
    total_bytes = mb * 1024 * 1024
    if total_bytes % track:
        total_bytes = (total_bytes // track + 1) * track
    cylinders = total_bytes // track

    # Cylinder 0 holds the IPL and the partition table; the volume starts at
    # cylinder 1 and runs to the last cylinder.
    part_start_cyl = 1
    part_end_cyl = cylinders - 1
    hidden = part_start_cyl * HDN_SECTORS_PER_TRACK * HDN_HEADS
    part_sectors = (part_end_cyl - part_start_cyl + 1) * HDN_SECTORS_PER_TRACK * HDN_HEADS

    spc = args.spc
    nroot = args.root
    reserved = 2                                  # as BTNPART lays it out
    # Each FAT must hold two reserved entries plus one per cluster.
    clusters = (part_sectors - reserved
                - (nroot * 32 + HDN_SECTOR - 1) // HDN_SECTOR) // spc
    spf = ((clusters + 2) * 2 + HDN_SECTOR - 1) // HDN_SECTOR
    # spf feeds back into the cluster count; one pass is enough at these sizes.
    clusters = (part_sectors - reserved - 2 * spf
                - (nroot * 32 + HDN_SECTOR - 1) // HDN_SECTOR) // spc
    if not 4085 < clusters < 65525:
        sys.exit('cluster count %d is outside FAT16 - adjust --spc' % clusters)

    image = bytearray(total_bytes)

    ipl = open(args.ipl, 'rb').read() if args.ipl else None
    if ipl:
        image[0:len(ipl)] = ipl[:HDN_SECTOR]

    image[HDN_SECTOR:HDN_SECTOR + 32] = pc98_partition_entry(
        part_start_cyl, part_end_cyl, HDN_HEADS, HDN_SECTORS_PER_TRACK,
        args.label)

    part_off = hidden * HDN_SECTOR
    image[part_off:part_off + HDN_SECTOR] = build_bpb(
        bps=HDN_SECTOR, spc=spc, reserved=reserved, nfats=2, nroot=nroot,
        total=part_sectors, media=0xf8, spf=spf,
        spt=HDN_SECTORS_PER_TRACK, heads=HDN_HEADS, hidden=hidden,
        label=args.label, fat16=True, oem=b'NP2WASM ')
    bpb = Bpb(image, part_off)
    # BTNPART writes 0xfe here even though the BPB media byte is 0xf8; DOS
    # only looks at the BPB, so keep the pair it produces.
    init_fat(image, bpb, 0xfe)
    set_label(image, bpb, args.label)

    open(args.image, 'wb').write(image)
    print('%s: %d bytes (%d MB), C/H/S = %d/%d/%d%s'
          % (args.image, len(image), len(image) // 1024 // 1024,
             cylinders, HDN_HEADS, HDN_SECTORS_PER_TRACK,
             '' if ipl else '  (no IPL - will not get a drive letter)'))
    print('  partition cylinders %d..%d, %d sectors, hidden=%d'
          % (part_start_cyl, part_end_cyl, part_sectors, hidden))
    print('  volume: %s' % bpb.describe())


# --------------------------------------------------------------------------
# adding files
# --------------------------------------------------------------------------

class Dir:
    """Either the root directory or a subdirectory cluster chain."""

    def __init__(self, image, bpb, first_cluster=None):
        self.image = image
        self.bpb = bpb
        self.first = first_cluster          # None = root

    def entries(self):
        if self.first is None:
            for i in range(self.bpb.nroot):
                p = self.bpb.root_start + i * 32
                yield p
            return
        csize = self.bpb.spc * self.bpb.bps
        for cl in chain(self.image, self.bpb, self.first):
            base = self.bpb.cluster_offset(cl)
            for i in range(csize // 32):
                yield base + i * 32

    def alloc(self):
        for p in self.entries():
            if self.image[p] in (0x00, 0xe5):
                return p
        if self.first is None:
            raise IOError('root directory full')
        # grow the chain by one cluster
        cls = chain(self.image, self.bpb, self.first)
        new = free_clusters(self.image, self.bpb, 1)[0]
        fat_set(self.image, self.bpb, cls[-1], new)
        fat_set(self.image, self.bpb, new, fat_eoc(self.bpb))
        base = self.bpb.cluster_offset(new)
        csize = self.bpb.spc * self.bpb.bps
        self.image[base:base + csize] = bytes(csize)
        return base

    def find(self, name):
        want = dos_name(name)
        for p in self.entries():
            e = self.image[p:p + 32]
            if e[0] == 0x00:
                return None
            if e[0] == 0xe5:
                continue
            if bytes(e[0:11]) == want:
                return p
        return None


def _dir_entry(name, attr, cluster, size):
    e = bytearray(32)
    e[0:11] = dos_name(name)
    e[11] = attr
    struct.pack_into('<H', e, 22, 0x6000)          # time 12:00
    struct.pack_into('<H', e, 24, 0x5821)          # date 2024-01-01
    struct.pack_into('<H', e, 26, cluster)
    struct.pack_into('<I', e, 28, size)
    return e


def make_dir(image, bpb, parent, name):
    """Create a subdirectory under parent and return a Dir for it."""
    hit = parent.find(name)
    if hit is not None:
        return Dir(image, bpb, struct.unpack_from('<H', image, hit + 26)[0])

    cl = free_clusters(image, bpb, 1)[0]
    fat_set(image, bpb, cl, fat_eoc(bpb))
    csize = bpb.spc * bpb.bps
    base = bpb.cluster_offset(cl)
    image[base:base + csize] = bytes(csize)
    dot = _dir_entry('.', 0x10, cl, 0)
    dot[0:11] = b'.          '
    dotdot = _dir_entry('..', 0x10, 0 if parent.first is None else parent.first, 0)
    dotdot[0:11] = b'..         '
    image[base:base + 32] = dot
    image[base + 32:base + 64] = dotdot

    p = parent.alloc()
    image[p:p + 32] = _dir_entry(name, 0x10, cl, 0)
    return Dir(image, bpb, cl)


def add_file_to(image, bpb, directory, name, data):
    csize = bpb.spc * bpb.bps
    ncl = (len(data) + csize - 1) // csize
    cls = free_clusters(image, bpb, ncl) if ncl else []
    for i, cl in enumerate(cls):
        o = bpb.cluster_offset(cl)
        piece = data[i * csize:(i + 1) * csize]
        image[o:o + len(piece)] = piece
        fat_set(image, bpb, cl, cls[i + 1] if i + 1 < len(cls) else fat_eoc(bpb))
    p = directory.alloc()
    image[p:p + 32] = _dir_entry(name, 0x20, cls[0] if cls else 0, len(data))
    return ncl


def alloc_dir_entry(image, bpb):
    for p, e in read_dir(image, bpb, None):
        if e[0] in (0x00, 0xe5):
            return p
    raise IOError('root directory full')


def add_file(image, bpb, name, data):
    csize = bpb.spc * bpb.bps
    # a zero-length file gets no clusters
    ncl = (len(data) + csize - 1) // csize
    cls = free_clusters(image, bpb, ncl) if ncl else []
    for i, cl in enumerate(cls):
        o = bpb.cluster_offset(cl)
        piece = data[i * csize:(i + 1) * csize]
        image[o:o + len(piece)] = piece
        fat_set(image, bpb, cl, cls[i + 1] if i + 1 < len(cls) else fat_eoc(bpb))

    p = alloc_dir_entry(image, bpb)
    e = bytearray(32)
    e[0:11] = dos_name(name)
    e[11] = 0x20                                   # archive
    struct.pack_into('<H', e, 22, 0x6000)          # time 12:00
    struct.pack_into('<H', e, 24, 0x5821)          # date 2024-01-01
    struct.pack_into('<H', e, 26, cls[0] if cls else 0)
    struct.pack_into('<I', e, 28, len(data))
    image[p:p + 32] = e
    return ncl


def add_tree(image, bpb, directory, path, prefix=''):
    """Copy a host file or directory in, recursing into subdirectories."""
    added = 0
    if os.path.isdir(path):
        for name in sorted(os.listdir(path)):
            child = os.path.join(path, name)
            if os.path.isdir(child):
                sub = make_dir(image, bpb, directory, name)
                print('  + %s%s%s' % (prefix, name, os.sep))
                added += add_tree(image, bpb, sub, child, prefix + name + os.sep)
            else:
                data = open(child, 'rb').read()
                add_file_to(image, bpb, directory, name, data)
                print('  + %s%-14s %8d' % (prefix, name, len(data)))
                added += 1
        return added
    data = open(path, 'rb').read()
    name = os.path.basename(path)
    add_file_to(image, bpb, directory, name, data)
    print('  + %s%-14s %8d' % (prefix, name, len(data)))
    return 1


def cmd_add(args):
    image = bytearray(open(args.image, 'rb').read())
    bpb = Bpb(image, args.offset)
    root = Dir(image, bpb, None)
    target = root
    if args.dir:
        for part in args.dir.replace('\\', '/').strip('/').split('/'):
            target = make_dir(image, bpb, target, part)
    added = 0
    for src in args.src:
        added += add_tree(image, bpb, target, src)
    open(args.image, 'wb').write(image)
    free = sum(1 for cl in range(2, bpb.clusters + 2)
               if fat_get(image, bpb, cl) == 0)
    print('%d files added, %d clusters free (%d KB)'
          % (added, free, free * bpb.spc * bpb.bps // 1024))


def cmd_info(args):
    image = bytearray(open(args.image, 'rb').read())
    print('size %d bytes' % len(image))
    print('sector 0 signature: %s' % image[510:512].hex())
    if len(image) > 512:
        print('sector 1 (partition table) first entry: %s' % image[512:512 + 32].hex())
    for off in (0, 512, 0x2800, 0x1400):
        try:
            print('BPB at 0x%x: %s' % (off, Bpb(image, off).describe()))
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('ls'); p.add_argument('image'); p.add_argument('--offset', type=int, default=0); p.set_defaults(fn=cmd_ls)
    p = sub.add_parser('extract'); p.add_argument('image'); p.add_argument('name'); p.add_argument('out'); p.add_argument('--offset', type=int, default=0); p.set_defaults(fn=cmd_extract)
    p = sub.add_parser('mkfd'); p.add_argument('image'); p.add_argument('--label', default='NP2KAI'); p.set_defaults(fn=cmd_mkfd)
    p = sub.add_parser('add'); p.add_argument('image'); p.add_argument('src', nargs='+'); p.add_argument('--dir'); p.add_argument('--offset', type=int, default=0); p.set_defaults(fn=cmd_add)
    p = sub.add_parser('mkhdn'); p.add_argument('image')
    p.add_argument('--mb', type=int, default=100)
    p.add_argument('--label', default='NP2KAI')
    p.add_argument('--spc', type=int, default=4, help='sectors per cluster')
    p.add_argument('--root', type=int, default=3072, help='root directory entries')
    p.add_argument('--ipl', default='web/bios/pc98_ipl.bin',
                   help='512-byte PC-98 IPL for sector 0')
    p.set_defaults(fn=cmd_mkhdn)
    p = sub.add_parser('info'); p.add_argument('image'); p.set_defaults(fn=cmd_info)

    args = ap.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
