// The one place that talks to pc98fat.wasm.
//
// Everything about PC-98 disk images - the FAT12/FAT16 handling, the partition
// layout, building a formatted image from nothing - lives in
// tools/pc98fat/pc98fat.c, where a native self test and a cross-check against
// tools/fatimg.py keep it honest. This file is only the calling convention:
// allocate a buffer, hand over a pointer, read the result back.
//
// The module holds one volume at a time, so an image stays resident while it
// is being worked on rather than being copied in and out per call - which
// matters at 100MB.

import createPc98Fat from './pc98fat.js';

let mod = null;
let openHandle = null;

async function fat() {
	if (!mod) mod = await createPc98Fat();
	return mod;
}

function lastError(m) {
	return m.ccall('pc98fat_error', 'string', [], []) || 'unknown error';
}

/**
 * Copy an image into wasm memory and open it as a volume. Returns a handle
 * with the file operations on it; call close() when done, or open another
 * image, which closes this one.
 */
export async function openImage(bytes) {
	const m = await fat();
	if (openHandle) openHandle.close();

	const ptr = m._malloc(bytes.length);
	m.HEAPU8.set(bytes, ptr);
	if (m.ccall('pc98fat_open', 'number', ['number', 'number'],
	            [ptr, bytes.length]) !== 0) {
		const message = lastError(m);
		m._free(ptr);
		throw new Error(message);
	}

	const handle = {
		get closed() { return ptr === 0; },

		/** The image as it stands, including anything written since opening. */
		bytes() {
			return new Uint8Array(m.HEAPU8.subarray(ptr, ptr + bytes.length));
		},

		info() {
			const num = (fn) => m.ccall(fn, 'number', [], []);
			return {
				volumeOffset: num('pc98fat_volume_offset'),
				bytesPerSector: num('pc98fat_bytes_per_sector'),
				clusterSize: num('pc98fat_cluster_size'),
				fatBits: num('pc98fat_fat_bits'),
				clusters: num('pc98fat_cluster_count'),
				freeBytes: num('pc98fat_free_bytes'),
				totalBytes: num('pc98fat_total_bytes'),
			};
		},

		list(dir) {
			const n = m.ccall('pc98fat_list', 'number', ['string'], [dir || '/']);
			if (n < 0) throw new Error(lastError(m));
			const text = m.ccall('pc98fat_listing', 'string', [], []);
			return text.split('\n').filter(Boolean).map((line) => {
				const [name, size, attr] = line.split('\t');
				return { name, size: Number(size), attr: Number(attr) };
			});
		},

		read(path) {
			const size = m.ccall('pc98fat_size', 'number', ['string'], [path]);
			if (size < 0) throw new Error(lastError(m));
			const out = m._malloc(size || 1);
			try {
				const got = m.ccall('pc98fat_read', 'number',
				                    ['string', 'number', 'number'],
				                    [path, out, size]);
				if (got < 0) throw new Error(lastError(m));
				return new Uint8Array(m.HEAPU8.subarray(out, out + got));
			} finally {
				m._free(out);
			}
		},

		write(path, data) {
			const buf = m._malloc(data.length || 1);
			try {
				m.HEAPU8.set(data, buf);
				const r = m.ccall('pc98fat_write', 'number',
				                  ['string', 'number', 'number'],
				                  [path, buf, data.length]);
				if (r < 0) throw new Error(lastError(m));
				return r;
			} finally {
				m._free(buf);
			}
		},

		remove(path) {
			if (m.ccall('pc98fat_delete', 'number', ['string'], [path]) < 0) {
				throw new Error(lastError(m));
			}
		},

		mkdir(path) {
			if (m.ccall('pc98fat_mkdir', 'number', ['string'], [path]) < 0) {
				throw new Error(lastError(m));
			}
		},

		close() {
			if (ptr === 0) return;
			m.ccall('pc98fat_close', null, [], []);
			m._free(ptr);
			if (openHandle === handle) openHandle = null;
		},
	};
	openHandle = handle;
	return handle;
}

/**
 * A .hdn SCSI image of `mb` megabytes, partitioned and FAT16 formatted, ready
 * for FreeDOS(98) to give a drive letter. `ipl` is the 512-byte PC-98 IPL;
 * without it the kernel offers the partition no letter at all.
 */
export async function makeHdn(mb, label, ipl) {
	const m = await fat();
	const size = m.ccall('pc98fat_hdn_size', 'number', ['number'], [mb]);
	if (size <= 0) throw new Error('bad size: ' + mb + 'MB');

	const ptr = m._malloc(size);
	const iplPtr = ipl ? m._malloc(ipl.length) : 0;
	try {
		m.HEAPU8.fill(0, ptr, ptr + size);
		if (iplPtr) m.HEAPU8.set(ipl, iplPtr);
		const r = m.ccall('pc98fat_mkhdn', 'number',
		                  ['number', 'number', 'string', 'number', 'number',
		                   'number', 'number'],
		                  [ptr, size, label || 'NP2WASM', iplPtr,
		                   ipl ? ipl.length : 0, 0, 0]);
		if (r !== 0) throw new Error(lastError(m));
		return new Uint8Array(m.HEAPU8.subarray(ptr, ptr + size));
	} finally {
		if (iplPtr) m._free(iplPtr);
		m._free(ptr);
	}
}

/** A blank PC-98 2HD (1.2MB) FAT12 floppy. */
export async function makeFd2hd(label) {
	const m = await fat();
	const size = m.ccall('pc98fat_fd2hd_size', 'number', [], []);
	const ptr = m._malloc(size);
	try {
		m.HEAPU8.fill(0, ptr, ptr + size);
		const r = m.ccall('pc98fat_mkfd2hd', 'number',
		                  ['number', 'number', 'string'],
		                  [ptr, size, label || 'NP2WASM']);
		if (r !== 0) throw new Error(lastError(m));
		return new Uint8Array(m.HEAPU8.subarray(ptr, ptr + size));
	} finally {
		m._free(ptr);
	}
}
