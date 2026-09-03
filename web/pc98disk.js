// PC-98 disk image creation in the browser.
//
// The JS half of tools/fatimg.py. The layout here is not guessed: a blank
// image was partitioned by FreeDOS(98)'s own BTNPART.EXE inside the emulator
// and the result read back out, so the BPB, the partition entry and the FAT
// seeds are what that tool produces. See tools/fatimg.py for the same code
// with the derivation written up.

const HDN_SECTOR = 512;
const HDN_SPT = 25;              // sectors per track, .hdn / PC-9801-55
const HDN_HEADS = 8;

const FD_2HD_SECTOR = 1024;
const FD_2HD_SECTORS = 1232;     // 77 cylinders x 2 heads x 8 sectors

function putU16(view, off, v) { view.setUint16(off, v, true); }
function putU32(view, off, v) { view.setUint32(off, v, true); }

function putAscii(bytes, off, text, len, pad) {
	const s = (text + '').toUpperCase();
	for (let i = 0; i < len; i++) {
		const c = i < s.length ? s.charCodeAt(i) : (pad || 0x20);
		bytes[off + i] = c < 0x100 ? c : 0x3f;   // '?' for anything not 8-bit
	}
}

function buildBpb({ bps, spc, reserved, nfats, nroot, total, media, spf, spt,
                    heads, hidden, label, fat16, oem }) {
	const bytes = new Uint8Array(bps);
	const view = new DataView(bytes.buffer);
	bytes[0] = 0xeb; bytes[1] = 0x00; bytes[2] = 0x90;   // a jump, so DOS accepts it
	putAscii(bytes, 3, oem, 8);
	putU16(view, 11, bps);
	bytes[13] = spc;
	putU16(view, 14, reserved);
	bytes[16] = nfats;
	putU16(view, 17, nroot);
	putU16(view, 19, total > 0xffff ? 0 : total);
	bytes[21] = media;
	putU16(view, 22, spf);
	putU16(view, 24, spt);
	putU16(view, 26, heads);
	putU32(view, 28, hidden || 0);
	putU32(view, 32, total > 0xffff ? total : 0);
	bytes[36] = fat16 ? 0x80 : 0x00;                     // BIOS drive number
	bytes[38] = 0x29;                                    // extended boot signature
	putU32(view, 39, 0x12345678);                        // volume serial
	putAscii(bytes, 43, label, 11);
	putAscii(bytes, 54, fat16 ? 'FAT16' : 'FAT12', 8);
	bytes[bps - 2] = 0x55; bytes[bps - 1] = 0xaa;
	return bytes;
}

// Sector 1 of a PC-98 hard disk holds up to 16 of these.
//   +0  mid 0xa1 / +1 sid 0xa1  (bootable DOS partition)
//   +4  IPL   sector, head, cylinder(LE16)
//   +8  start sector, head, cylinder(LE16)
//   +12 end   sector, head, cylinder(LE16), inclusive
//   +16 name, 16 bytes, space padded
function partitionEntry(startCyl, endCyl, heads, spt, label) {
	const bytes = new Uint8Array(32);
	const view = new DataView(bytes.buffer);
	bytes[0] = 0xa1;
	bytes[1] = 0xa1;
	bytes[4] = 0; bytes[5] = 0; putU16(view, 6, startCyl);
	bytes[8] = 0; bytes[9] = 0; putU16(view, 10, startCyl);
	bytes[12] = spt - 1; bytes[13] = heads - 1; putU16(view, 14, endCyl);
	putAscii(bytes, 16, label, 16);
	return bytes;
}

/**
 * A .hdn SCSI image with one FAT16 partition covering the disk.
 *
 * `ipl` must be the 512-byte PC-98 IPL. Without it the FreeDOS(98) kernel
 * gives the partition no drive letter at all - BTNPART reports writing the
 * IPL but the bytes never reach the image under np2's SCSI emulation, which
 * is why this writes it directly.
 */
export function createHdn({ mb = 100, label = 'NP2WASM', ipl = null,
                            spc = 4, nroot = 3072 } = {}) {
	const track = HDN_SECTOR * HDN_SPT * HDN_HEADS;
	let totalBytes = mb * 1024 * 1024;
	if (totalBytes % track) totalBytes = (Math.floor(totalBytes / track) + 1) * track;
	const cylinders = totalBytes / track;

	// Cylinder 0 holds the IPL and the partition table.
	const startCyl = 1;
	const endCyl = cylinders - 1;
	const hidden = startCyl * HDN_SPT * HDN_HEADS;
	const partSectors = (endCyl - startCyl + 1) * HDN_SPT * HDN_HEADS;

	const rootSectors = Math.ceil(nroot * 32 / HDN_SECTOR);
	const reserved = 2;
	let clusters = Math.floor((partSectors - reserved - rootSectors) / spc);
	const spf = Math.ceil((clusters + 2) * 2 / HDN_SECTOR);
	clusters = Math.floor((partSectors - reserved - 2 * spf - rootSectors) / spc);
	if (!(clusters > 4085 && clusters < 65525)) {
		throw new Error('cluster count ' + clusters + ' is outside FAT16');
	}

	const image = new Uint8Array(totalBytes);
	if (ipl) image.set(ipl.subarray(0, HDN_SECTOR), 0);
	image.set(partitionEntry(startCyl, endCyl, HDN_HEADS, HDN_SPT, label),
	          HDN_SECTOR);

	const partOff = hidden * HDN_SECTOR;
	image.set(buildBpb({
		bps: HDN_SECTOR, spc, reserved, nfats: 2, nroot,
		total: partSectors, media: 0xf8, spf, spt: HDN_SPT, heads: HDN_HEADS,
		hidden, label, fat16: true, oem: 'NP2WASM',
	}), partOff);

	// FAT[0] = 0xfffe, FAT[1] = 0xffff in both copies. BTNPART writes 0xfe as
	// the low byte even though the BPB media byte is 0xf8; DOS reads the BPB.
	for (let n = 0; n < 2; n++) {
		const off = partOff + (reserved + n * spf) * HDN_SECTOR;
		image[off] = 0xfe; image[off + 1] = 0xff;
		image[off + 2] = 0xff; image[off + 3] = 0xff;
	}

	// Volume label as the first root directory entry.
	const rootOff = partOff + (reserved + 2 * spf) * HDN_SECTOR;
	putAscii(image, rootOff, label, 11);
	image[rootOff + 11] = 0x08;

	return {
		image,
		info: {
			mb: totalBytes / 1024 / 1024,
			cylinders, heads: HDN_HEADS, sectors: HDN_SPT,
			clusters, spc, spf, partSectors, hidden,
		},
	};
}

/** A blank PC-98 2HD (1.2MB) FAT12 floppy. */
export function createFd2hd({ label = 'NP2WASM' } = {}) {
	const image = new Uint8Array(FD_2HD_SECTOR * FD_2HD_SECTORS);
	image.set(buildBpb({
		bps: FD_2HD_SECTOR, spc: 1, reserved: 1, nfats: 2, nroot: 192,
		total: FD_2HD_SECTORS, media: 0xfe, spf: 2, spt: 8, heads: 2,
		hidden: 0, label, fat16: false, oem: 'NP2WASM',
	}), 0);
	for (let n = 0; n < 2; n++) {
		const off = (1 + n * 2) * FD_2HD_SECTOR;
		image[off] = 0xfe; image[off + 1] = 0xff; image[off + 2] = 0xff;
	}
	const rootOff = (1 + 2 * 2) * FD_2HD_SECTOR;
	putAscii(image, rootOff, label, 11);
	image[rootOff + 11] = 0x08;
	return { image, info: { mb: image.length / 1024 / 1024 } };
}
