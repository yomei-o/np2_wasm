/*
 * pc98fat - read and write PC-98 disk images, compiled to its own wasm module.
 *
 * The demo page needs to get a source file into a disk image and a build
 * artifact back out, without booting anything. This is the same FAT12/FAT16
 * handling as tools/fatimg.py, in C, exposed to JS.
 *
 * Deliberately narrow: FAT12 and FAT16, 8.3 names, no long file names. That
 * covers every image a PC-98 ever wrote, and it means names are just bytes -
 * Shift-JIS file names survive without a code page table.
 *
 * The image is a caller-owned buffer. Nothing is cached, so every call sees
 * the current bytes and the caller can hand the same buffer to a download or
 * back to IndexedDB when it is done.
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#define LISTBUF_SIZE (256 * 1024)
#define MAX_PATH_LEN 260
#define ATTR_READONLY 0x01
#define ATTR_HIDDEN   0x02
#define ATTR_SYSTEM   0x04
#define ATTR_VOLUME   0x08
#define ATTR_DIR      0x10
#define ATTR_ARCHIVE  0x20
#define ATTR_LFN      0x0f

enum {
	PF_OK = 0,
	PF_ERR_NOIMAGE = -1,
	PF_ERR_NOVOLUME = -2,
	PF_ERR_NOTFOUND = -3,
	PF_ERR_EXISTS = -4,
	PF_ERR_FULL = -5,
	PF_ERR_TOOSMALL = -6,
	PF_ERR_BADNAME = -7,
	PF_ERR_NOTDIR = -8,
	PF_ERR_ISDIR = -9,
	PF_ERR_NOTEMPTY = -10,
	PF_ERR_READONLY = -11
};

typedef struct {
	uint8_t *img;
	uint32_t imgsize;

	uint32_t base;          /* byte offset of the volume inside the image */
	uint32_t bps;           /* bytes per sector */
	uint32_t spc;           /* sectors per cluster */
	uint32_t reserved;
	uint32_t nfats;
	uint32_t nroot;         /* root directory entries; 0 would mean FAT32 */
	uint32_t spf;           /* sectors per FAT */
	uint32_t total;         /* total sectors in the volume */
	uint32_t clusters;      /* count of data clusters */
	int fat16;

	uint32_t fat_off;       /* byte offsets, absolute in the image */
	uint32_t root_off;
	uint32_t data_off;
} VOL;

static VOL vol;
static char errbuf[128];
static char listbuf[LISTBUF_SIZE];
static uint32_t listlen;

static void set_err(const char *msg)
{
	snprintf(errbuf, sizeof(errbuf), "%s", msg);
}

static uint16_t rd16(const uint8_t *p)
{
	return (uint16_t)(p[0] | (p[1] << 8));
}

static uint32_t rd32(const uint8_t *p)
{
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8)
	     | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void wr16(uint8_t *p, uint16_t v)
{
	p[0] = (uint8_t)v;
	p[1] = (uint8_t)(v >> 8);
}

static void wr32(uint8_t *p, uint32_t v)
{
	p[0] = (uint8_t)v;
	p[1] = (uint8_t)(v >> 8);
	p[2] = (uint8_t)(v >> 16);
	p[3] = (uint8_t)(v >> 24);
}

/* ---------------------------------------------------------------- volume */

static int bpb_plausible(const uint8_t *p, uint32_t avail)
{
	uint32_t bps = rd16(p + 11);
	uint32_t spc = p[13];
	uint32_t nfats = p[16];
	uint32_t total = rd16(p + 19);
	uint32_t spf = rd16(p + 22);

	if (total == 0) {
		total = rd32(p + 32);
	}
	if (bps != 128 && bps != 256 && bps != 512 && bps != 1024
	    && bps != 2048 && bps != 4096) {
		return 0;
	}
	if (spc == 0 || (spc & (spc - 1)) != 0 || spc > 128) {
		return 0;
	}
	if (nfats < 1 || nfats > 2) {
		return 0;
	}
	if (spf == 0 || total == 0) {
		return 0;
	}
	if ((uint64_t)total * bps > (uint64_t)avail) {
		return 0;
	}
	return 1;
}

static int read_bpb(uint32_t base)
{
	const uint8_t *p = vol.img + base;

	if (base + 512 > vol.imgsize || !bpb_plausible(p, vol.imgsize - base)) {
		return 0;
	}
	vol.base = base;
	vol.bps = rd16(p + 11);
	vol.spc = p[13];
	vol.reserved = rd16(p + 14);
	vol.nfats = p[16];
	vol.nroot = rd16(p + 17);
	vol.spf = rd16(p + 22);
	vol.total = rd16(p + 19);
	if (vol.total == 0) {
		vol.total = rd32(p + 32);
	}

	vol.fat_off = base + vol.reserved * vol.bps;
	vol.root_off = vol.fat_off + vol.nfats * vol.spf * vol.bps;
	vol.data_off = vol.root_off
	             + ((vol.nroot * 32 + vol.bps - 1) / vol.bps) * vol.bps;

	{
		uint32_t data_sectors = vol.total
		                      - (vol.data_off - base) / vol.bps;
		vol.clusters = data_sectors / vol.spc;
	}
	vol.fat16 = (vol.clusters >= 4085);
	return 1;
}

/*
 * PC-98 hard disks put the partition table in sector 1, 16 entries of 32
 * bytes. The geometry comes out of the entry itself: the end sector and head
 * are inclusive, so sectors-per-track and heads follow from them, and the
 * volume starts at its start cylinder. See tools/fatimg.py for where this
 * layout was read off a BTNPART-partitioned image.
 */
static int find_pc98_partition(uint32_t *offset_out)
{
	uint32_t i;

	if (vol.imgsize < 1024) {
		return 0;
	}
	for (i = 0; i < 16; i++) {
		const uint8_t *e = vol.img + 512 + i * 32;
		uint32_t spt, heads, start_cyl, off;

		if (e[0] == 0 && e[1] == 0) {
			continue;
		}
		spt = (uint32_t)e[12] + 1;
		heads = (uint32_t)e[13] + 1;
		start_cyl = rd16(e + 10);
		if (spt == 0 || heads == 0 || spt > 255 || heads > 255) {
			continue;
		}
		off = start_cyl * heads * spt * 512u;
		if (off + 512 <= vol.imgsize
		    && bpb_plausible(vol.img + off, vol.imgsize - off)) {
			*offset_out = off;
			return 1;
		}
	}
	return 0;
}

EXPORT
int pc98fat_open(uint8_t *image, int size)
{
	uint32_t part;

	memset(&vol, 0, sizeof(vol));
	errbuf[0] = '\0';
	if (image == NULL || size <= 0) {
		set_err("no image");
		return PF_ERR_NOIMAGE;
	}
	vol.img = image;
	vol.imgsize = (uint32_t)size;

	/* A floppy has its BPB in the first sector; a partitioned hard disk has
	 * an IPL there instead. */
	if (read_bpb(0)) {
		return PF_OK;
	}
	if (find_pc98_partition(&part) && read_bpb(part)) {
		return PF_OK;
	}
	set_err("no FAT volume found (not a PC-98 FAT12/16 image?)");
	memset(&vol, 0, sizeof(vol));
	return PF_ERR_NOVOLUME;
}

EXPORT int pc98fat_volume_offset(void) { return (int)vol.base; }
EXPORT int pc98fat_bytes_per_sector(void) { return (int)vol.bps; }
EXPORT int pc98fat_cluster_size(void) { return (int)(vol.spc * vol.bps); }
EXPORT int pc98fat_fat_bits(void) { return vol.fat16 ? 16 : 12; }
EXPORT int pc98fat_cluster_count(void) { return (int)vol.clusters; }
EXPORT const char *pc98fat_error(void) { return errbuf; }

/* ------------------------------------------------------------------- FAT */

static uint32_t fat_get(uint32_t cl)
{
	if (!vol.fat16) {
		uint32_t i = vol.fat_off + cl + (cl >> 1);
		uint32_t v = rd16(vol.img + i);
		return (cl & 1) ? (v >> 4) : (v & 0x0fff);
	}
	return rd16(vol.img + vol.fat_off + cl * 2);
}

static void fat_set(uint32_t cl, uint32_t value)
{
	uint32_t n;

	for (n = 0; n < vol.nfats; n++) {
		uint32_t base = vol.fat_off + n * vol.spf * vol.bps;

		if (!vol.fat16) {
			uint32_t i = base + cl + (cl >> 1);
			uint32_t v = rd16(vol.img + i);
			v = (cl & 1) ? ((value << 4) | (v & 0x000f))
			             : ((v & 0xf000) | (value & 0x0fff));
			wr16(vol.img + i, (uint16_t)v);
		} else {
			wr16(vol.img + base + cl * 2, (uint16_t)value);
		}
	}
}

static uint32_t fat_eoc(void) { return vol.fat16 ? 0xffff : 0x0fff; }
static uint32_t fat_limit(void) { return vol.fat16 ? 0xfff0 : 0x0ff0; }

static uint32_t cluster_offset(uint32_t cl)
{
	return vol.data_off + (cl - 2) * vol.spc * vol.bps;
}

static int alloc_clusters(uint32_t need, uint32_t *first)
{
	uint32_t cl, prev = 0, got = 0;

	*first = 0;
	for (cl = 2; cl < vol.clusters + 2 && got < need; cl++) {
		if (fat_get(cl) != 0) {
			continue;
		}
		if (prev) {
			fat_set(prev, cl);
		} else {
			*first = cl;
		}
		fat_set(cl, fat_eoc());
		prev = cl;
		got++;
	}
	if (got < need) {
		/* roll back */
		if (*first) {
			uint32_t c = *first;
			while (c >= 2 && c < fat_limit()) {
				uint32_t next = fat_get(c);
				fat_set(c, 0);
				c = next;
			}
		}
		*first = 0;
		set_err("not enough free space");
		return PF_ERR_FULL;
	}
	return PF_OK;
}

static void free_chain(uint32_t cl)
{
	while (cl >= 2 && cl < fat_limit()) {
		uint32_t next = fat_get(cl);
		fat_set(cl, 0);
		cl = next;
	}
}

/* -------------------------------------------------------------- 8.3 names */

/* "README.TXT" -> "README  TXT". Returns 0 if the name cannot be one. */
static int to_83(const char *name, uint8_t out[11])
{
	const char *dot;
	size_t stem, ext, i;

	memset(out, ' ', 11);
	if (name[0] == '\0') {
		return 0;
	}
	if (strcmp(name, ".") == 0) {
		out[0] = '.';
		return 1;
	}
	if (strcmp(name, "..") == 0) {
		out[0] = '.';
		out[1] = '.';
		return 1;
	}
	dot = strrchr(name, '.');
	stem = dot ? (size_t)(dot - name) : strlen(name);
	ext = dot ? strlen(dot + 1) : 0;
	if (stem == 0 || stem > 8 || ext > 3) {
		return 0;
	}
	for (i = 0; i < stem; i++) {
		unsigned char c = (unsigned char)name[i];
		out[i] = (c >= 'a' && c <= 'z') ? (uint8_t)(c - 32) : (uint8_t)c;
	}
	for (i = 0; i < ext; i++) {
		unsigned char c = (unsigned char)dot[1 + i];
		out[8 + i] = (c >= 'a' && c <= 'z') ? (uint8_t)(c - 32) : (uint8_t)c;
	}
	return 1;
}

static void from_83(const uint8_t *e, char *out)
{
	int i, n = 0;

	for (i = 0; i < 8 && e[i] != ' '; i++) {
		out[n++] = (char)e[i];
	}
	if (e[8] != ' ') {
		out[n++] = '.';
		for (i = 8; i < 11 && e[i] != ' '; i++) {
			out[n++] = (char)e[i];
		}
	}
	out[n] = '\0';
}

/* ------------------------------------------------------------ directories */

typedef struct {
	int is_root;
	uint32_t first;         /* first cluster, for a subdirectory */
} DIR_T;

/* Nth 32-byte slot of a directory, or NULL past the end. Grows nothing. */
static uint8_t *dir_slot(const DIR_T *d, uint32_t index)
{
	if (d->is_root) {
		if (index >= vol.nroot) {
			return NULL;
		}
		return vol.img + vol.root_off + index * 32;
	}
	{
		uint32_t per = vol.spc * vol.bps / 32;
		uint32_t want = index / per;
		uint32_t cl = d->first;
		uint32_t hop = 0;

		while (cl >= 2 && cl < fat_limit()) {
			if (hop == want) {
				return vol.img + cluster_offset(cl) + (index % per) * 32;
			}
			cl = fat_get(cl);
			hop++;
		}
	}
	return NULL;
}

/* A free slot, growing a subdirectory by a cluster if it is full. */
static uint8_t *dir_alloc(const DIR_T *d)
{
	uint32_t i;
	uint8_t *slot;

	for (i = 0; (slot = dir_slot(d, i)) != NULL; i++) {
		if (slot[0] == 0x00 || slot[0] == 0xe5) {
			return slot;
		}
	}
	if (d->is_root) {
		set_err("root directory is full");
		return NULL;
	}
	{
		uint32_t cl = d->first, last = d->first, add;
		uint32_t per = vol.spc * vol.bps / 32;

		while (cl >= 2 && cl < fat_limit()) {
			last = cl;
			cl = fat_get(cl);
		}
		if (alloc_clusters(1, &add) != PF_OK) {
			return NULL;
		}
		fat_set(last, add);
		memset(vol.img + cluster_offset(add), 0, vol.spc * vol.bps);
		(void)per;
		return vol.img + cluster_offset(add);
	}
}

static uint8_t *dir_find(const DIR_T *d, const char *name)
{
	uint8_t want[11];
	uint32_t i;
	uint8_t *slot;

	if (!to_83(name, want)) {
		return NULL;
	}
	for (i = 0; (slot = dir_slot(d, i)) != NULL; i++) {
		if (slot[0] == 0x00) {
			return NULL;
		}
		if (slot[0] == 0xe5 || (slot[11] & ATTR_LFN) == ATTR_LFN) {
			continue;
		}
		if ((slot[11] & ATTR_VOLUME) && !(slot[11] & ATTR_DIR)) {
			continue;
		}
		if (memcmp(slot, want, 11) == 0) {
			return slot;
		}
	}
	return NULL;
}

static void fill_entry(uint8_t *e, const char *name, uint8_t attr,
                       uint32_t cluster, uint32_t size)
{
	uint8_t n83[11];

	to_83(name, n83);
	memset(e, 0, 32);
	memcpy(e, n83, 11);
	e[11] = attr;
	wr16(e + 22, 0x6000);          /* 12:00 */
	wr16(e + 24, 0x5821);          /* 2024-01-01 */
	wr16(e + 26, (uint16_t)cluster);
	wr32(e + 28, size);
}

/*
 * Walk a path. On return *dir is the directory holding the last component and
 * *leaf points at it (NUL terminated, in scratch). Intermediate components
 * must exist and be directories.
 */
static int walk(const char *path, DIR_T *dir, char *leaf, size_t leafsize)
{
	char buf[MAX_PATH_LEN];
	char *p, *seg, *next;

	if (strlen(path) >= sizeof(buf)) {
		set_err("path too long");
		return PF_ERR_BADNAME;
	}
	strcpy(buf, path);
	for (p = buf; *p; p++) {
		if (*p == '\\') {
			*p = '/';
		}
	}
	p = buf;
	while (*p == '/') {
		p++;
	}

	dir->is_root = 1;
	dir->first = 0;
	leaf[0] = '\0';

	seg = p;
	while (seg && *seg) {
		next = strchr(seg, '/');
		if (next) {
			*next = '\0';
			next++;
			while (*next == '/') {
				next++;
			}
		}
		if (next && *next) {
			uint8_t *e = dir_find(dir, seg);

			if (e == NULL) {
				set_err("no such directory");
				return PF_ERR_NOTFOUND;
			}
			if (!(e[11] & ATTR_DIR)) {
				set_err("not a directory");
				return PF_ERR_NOTDIR;
			}
			dir->is_root = 0;
			dir->first = rd16(e + 26);
			seg = next;
			continue;
		}
		snprintf(leaf, leafsize, "%s", seg);
		break;
	}
	return PF_OK;
}

/* Resolve a path that must name a directory. */
static int walk_dir(const char *path, DIR_T *dir)
{
	char leaf[64];
	int r = walk(path, dir, leaf, sizeof(leaf));

	if (r != PF_OK) {
		return r;
	}
	if (leaf[0] == '\0') {
		return PF_OK;                 /* the root */
	}
	{
		uint8_t *e = dir_find(dir, leaf);

		if (e == NULL) {
			set_err("no such directory");
			return PF_ERR_NOTFOUND;
		}
		if (!(e[11] & ATTR_DIR)) {
			set_err("not a directory");
			return PF_ERR_NOTDIR;
		}
		dir->is_root = 0;
		dir->first = rd16(e + 26);
	}
	return PF_OK;
}

/* ------------------------------------------------------------------- API */

/*
 * Fill the listing buffer with one line per entry:
 *   name<TAB>size<TAB>attr<TAB>cluster
 * Directories report size 0. Returns the entry count.
 */
EXPORT
int pc98fat_list(const char *path)
{
	DIR_T d;
	uint32_t i;
	uint8_t *slot;
	int count = 0;
	int r;

	listlen = 0;
	listbuf[0] = '\0';
	if (vol.img == NULL) {
		set_err("no image open");
		return PF_ERR_NOIMAGE;
	}
	r = walk_dir(path && path[0] ? path : "/", &d);
	if (r != PF_OK) {
		return r;
	}
	for (i = 0; (slot = dir_slot(&d, i)) != NULL; i++) {
		char name[16];
		int n;

		if (slot[0] == 0x00) {
			break;
		}
		if (slot[0] == 0xe5 || (slot[11] & ATTR_LFN) == ATTR_LFN) {
			continue;
		}
		if ((slot[11] & ATTR_VOLUME) && !(slot[11] & ATTR_DIR)) {
			continue;                 /* volume label */
		}
		if (slot[0] == '.') {
			continue;                 /* . and .. */
		}
		from_83(slot, name);
		n = snprintf(listbuf + listlen, LISTBUF_SIZE - listlen,
		             "%s\t%u\t%u\t%u\n", name,
		             (unsigned)rd32(slot + 28), (unsigned)slot[11],
		             (unsigned)rd16(slot + 26));
		if (n <= 0 || (uint32_t)n >= LISTBUF_SIZE - listlen) {
			break;
		}
		listlen += (uint32_t)n;
		count++;
	}
	return count;
}

EXPORT const char *pc98fat_listing(void) { return listbuf; }

static int find_file(const char *path, DIR_T *dir, uint8_t **entry)
{
	char leaf[64];
	int r = walk(path, dir, leaf, sizeof(leaf));

	if (r != PF_OK) {
		return r;
	}
	if (leaf[0] == '\0') {
		set_err("no file name given");
		return PF_ERR_BADNAME;
	}
	*entry = dir_find(dir, leaf);
	if (*entry == NULL) {
		set_err("no such file");
		return PF_ERR_NOTFOUND;
	}
	return PF_OK;
}

EXPORT
int pc98fat_size(const char *path)
{
	DIR_T d;
	uint8_t *e;
	int r = find_file(path, &d, &e);

	if (r != PF_OK) {
		return r;
	}
	if (e[11] & ATTR_DIR) {
		set_err("is a directory");
		return PF_ERR_ISDIR;
	}
	return (int)rd32(e + 28);
}

EXPORT
int pc98fat_read(const char *path, uint8_t *out, int outsize)
{
	DIR_T d;
	uint8_t *e;
	uint32_t size, cl, done = 0;
	uint32_t csize = vol.spc * vol.bps;
	int r = find_file(path, &d, &e);

	if (r != PF_OK) {
		return r;
	}
	if (e[11] & ATTR_DIR) {
		set_err("is a directory");
		return PF_ERR_ISDIR;
	}
	size = rd32(e + 28);
	if (outsize < 0 || (uint32_t)outsize < size) {
		set_err("output buffer too small");
		return PF_ERR_TOOSMALL;
	}
	cl = rd16(e + 26);
	while (done < size && cl >= 2 && cl < fat_limit()) {
		uint32_t n = size - done < csize ? size - done : csize;

		memcpy(out + done, vol.img + cluster_offset(cl), n);
		done += n;
		cl = fat_get(cl);
	}
	return (int)done;
}

EXPORT
int pc98fat_write(const char *path, const uint8_t *data, int size)
{
	DIR_T d;
	char leaf[64];
	uint8_t *e;
	uint32_t need, first = 0, cl, done = 0;
	uint32_t csize;
	int r;

	if (vol.img == NULL) {
		set_err("no image open");
		return PF_ERR_NOIMAGE;
	}
	if (size < 0) {
		set_err("bad size");
		return PF_ERR_TOOSMALL;
	}
	r = walk(path, &d, leaf, sizeof(leaf));
	if (r != PF_OK) {
		return r;
	}
	if (leaf[0] == '\0') {
		set_err("no file name given");
		return PF_ERR_BADNAME;
	}
	{
		uint8_t probe[11];

		if (!to_83(leaf, probe)) {
			set_err("not an 8.3 name");
			return PF_ERR_BADNAME;
		}
	}

	csize = vol.spc * vol.bps;
	e = dir_find(&d, leaf);
	if (e != NULL) {
		if (e[11] & ATTR_DIR) {
			set_err("is a directory");
			return PF_ERR_ISDIR;
		}
		if (e[11] & ATTR_READONLY) {
			set_err("read-only file");
			return PF_ERR_READONLY;
		}
		free_chain(rd16(e + 26));     /* overwrite */
	}

	need = ((uint32_t)size + csize - 1) / csize;
	if (need) {
		r = alloc_clusters(need, &first);
		if (r != PF_OK) {
			return r;
		}
	}
	cl = first;
	while (done < (uint32_t)size && cl >= 2 && cl < fat_limit()) {
		uint32_t n = (uint32_t)size - done < csize ? (uint32_t)size - done : csize;

		memcpy(vol.img + cluster_offset(cl), data + done, n);
		if (n < csize) {
			memset(vol.img + cluster_offset(cl) + n, 0, csize - n);
		}
		done += n;
		cl = fat_get(cl);
	}

	if (e == NULL) {
		e = dir_alloc(&d);
		if (e == NULL) {
			free_chain(first);
			return PF_ERR_FULL;
		}
	}
	fill_entry(e, leaf, ATTR_ARCHIVE, first, (uint32_t)size);
	return size;
}

EXPORT
int pc98fat_delete(const char *path)
{
	DIR_T d;
	uint8_t *e;
	int r = find_file(path, &d, &e);

	if (r != PF_OK) {
		return r;
	}
	if (e[11] & ATTR_DIR) {
		/* only if empty */
		DIR_T sub;
		uint32_t i;
		uint8_t *slot;

		sub.is_root = 0;
		sub.first = rd16(e + 26);
		for (i = 0; (slot = dir_slot(&sub, i)) != NULL; i++) {
			if (slot[0] == 0x00) {
				break;
			}
			if (slot[0] == 0xe5 || slot[0] == '.') {
				continue;
			}
			set_err("directory is not empty");
			return PF_ERR_NOTEMPTY;
		}
	}
	free_chain(rd16(e + 26));
	e[0] = 0xe5;
	return PF_OK;
}

EXPORT
int pc98fat_mkdir(const char *path)
{
	DIR_T d;
	char leaf[64];
	uint8_t *e, *base;
	uint32_t cl;
	int r;

	if (vol.img == NULL) {
		set_err("no image open");
		return PF_ERR_NOIMAGE;
	}
	r = walk(path, &d, leaf, sizeof(leaf));
	if (r != PF_OK) {
		return r;
	}
	if (leaf[0] == '\0') {
		set_err("no directory name given");
		return PF_ERR_BADNAME;
	}
	if (dir_find(&d, leaf) != NULL) {
		set_err("already exists");
		return PF_ERR_EXISTS;
	}
	r = alloc_clusters(1, &cl);
	if (r != PF_OK) {
		return r;
	}
	base = vol.img + cluster_offset(cl);
	memset(base, 0, vol.spc * vol.bps);
	fill_entry(base, ".", ATTR_DIR, cl, 0);
	fill_entry(base + 32, "..", ATTR_DIR, d.is_root ? 0 : d.first, 0);

	e = dir_alloc(&d);
	if (e == NULL) {
		free_chain(cl);
		return PF_ERR_FULL;
	}
	fill_entry(e, leaf, ATTR_DIR, cl, 0);
	return PF_OK;
}

EXPORT
double pc98fat_free_bytes(void)
{
	uint32_t cl, free_cl = 0;

	if (vol.img == NULL) {
		return 0.0;
	}
	for (cl = 2; cl < vol.clusters + 2; cl++) {
		if (fat_get(cl) == 0) {
			free_cl++;
		}
	}
	return (double)free_cl * (double)(vol.spc * vol.bps);
}

EXPORT
double pc98fat_total_bytes(void)
{
	if (vol.img == NULL) {
		return 0.0;
	}
	return (double)vol.clusters * (double)(vol.spc * vol.bps);
}

EXPORT
void pc98fat_close(void)
{
	memset(&vol, 0, sizeof(vol));
	listlen = 0;
	listbuf[0] = '\0';
}

/* ---------------------------------------------------------- making images */

/*
 * These write what FDISK and FORMAT would have written, and nothing else. A
 * FAT16 cluster is free when its FAT entry is zero, so a zero-filled buffer
 * already means "everything free"; only the IPL, the partition entry, the BPB,
 * the two FAT seeds and the volume label have to be filled in. For a 100MB
 * disk that is 291 bytes out of 104,857,600.
 *
 * The layout is not guessed. A blank image was partitioned by FreeDOS(98)'s
 * own BTNPART.EXE inside the emulator and read back out; see
 * tools/fatimg.py and RESUME.md for what that corrected.
 */

#define HDN_SECTOR 512
#define HDN_SPT 25              /* .hdn / PC-9801-55 geometry */
#define HDN_HEADS 8
#define FD_2HD_SECTOR 1024
#define FD_2HD_SECTORS 1232     /* 77 cylinders x 2 heads x 8 sectors */

/* Uppercase, space padded, and it stops at the terminator rather than reading
 * past it. */
static void put_ascii(uint8_t *dst, const char *text, uint32_t len)
{
	uint32_t i;
	int ended = (text == NULL);

	for (i = 0; i < len; i++) {
		unsigned char c;

		if (!ended && text[i] == '\0') {
			ended = 1;
		}
		if (ended) {
			dst[i] = ' ';
			continue;
		}
		c = (unsigned char)text[i];
		dst[i] = (c >= 'a' && c <= 'z') ? (uint8_t)(c - 32) : (uint8_t)c;
	}
}

static void build_bpb(uint8_t *sec, uint32_t bps, uint32_t spc,
                      uint32_t reserved, uint32_t nfats, uint32_t nroot,
                      uint32_t total, uint8_t media, uint32_t spf,
                      uint32_t spt, uint32_t heads, uint32_t hidden,
                      const char *label, int fat16)
{
	memset(sec, 0, bps);
	sec[0] = 0xeb;
	sec[1] = 0x00;
	sec[2] = 0x90;                            /* a jump, so DOS accepts it */
	put_ascii(sec + 3, "NP2WASM", 8);
	wr16(sec + 11, (uint16_t)bps);
	sec[13] = (uint8_t)spc;
	wr16(sec + 14, (uint16_t)reserved);
	sec[16] = (uint8_t)nfats;
	wr16(sec + 17, (uint16_t)nroot);
	wr16(sec + 19, total > 0xffff ? 0 : (uint16_t)total);
	sec[21] = media;
	wr16(sec + 22, (uint16_t)spf);
	wr16(sec + 24, (uint16_t)spt);
	wr16(sec + 26, (uint16_t)heads);
	wr32(sec + 28, hidden);
	wr32(sec + 32, total > 0xffff ? total : 0);
	sec[36] = fat16 ? 0x80 : 0x00;            /* BIOS drive: 0x80 = first HDD */
	sec[38] = 0x29;                           /* extended boot signature */
	wr32(sec + 39, 0x12345678);               /* volume serial */
	put_ascii(sec + 43, label, 11);
	put_ascii(sec + 54, fat16 ? "FAT16" : "FAT12", 8);
	sec[bps - 2] = 0x55;
	sec[bps - 1] = 0xaa;
}

/*
 * Sector 1 of a PC-98 hard disk holds up to 16 of these.
 *   +0  mid 0xa1 / +1 sid 0xa1   (bootable DOS partition)
 *   +4  IPL   sector, head, cylinder (LE16)
 *   +8  start sector, head, cylinder (LE16)
 *   +12 end   sector, head, cylinder (LE16), inclusive
 *   +16 name, 16 bytes, space padded
 */
static void build_partition(uint8_t *e, uint32_t start_cyl, uint32_t end_cyl,
                            uint32_t heads, uint32_t spt, const char *label)
{
	memset(e, 0, 32);
	e[0] = 0xa1;
	e[1] = 0xa1;
	wr16(e + 6, (uint16_t)start_cyl);         /* IPL at cylinder start */
	wr16(e + 10, (uint16_t)start_cyl);
	e[12] = (uint8_t)(spt - 1);
	e[13] = (uint8_t)(heads - 1);
	wr16(e + 14, (uint16_t)end_cyl);
	put_ascii(e + 16, label, 16);
}

static void seed_fats(uint8_t *part, uint32_t bps, uint32_t reserved,
                      uint32_t spf, uint8_t seed, int fat16)
{
	uint32_t n;

	/* FAT[0] takes the media byte in its low position and FAT[1] is all ones.
	 * BTNPART writes 0xfe here even where the BPB media byte is 0xf8; DOS
	 * reads the BPB, so keep the pair it produces. */
	for (n = 0; n < 2; n++) {
		uint8_t *p = part + (reserved + n * spf) * bps;

		p[0] = seed;
		p[1] = 0xff;
		p[2] = 0xff;
		if (fat16) {
			p[3] = 0xff;
		}
	}
}

/*
 * A .hdn SCSI image with one FAT16 partition covering the disk. `ipl` must be
 * the 512-byte PC-98 IPL: BTNPART reports writing it but the bytes never
 * reach the image under np2's SCSI emulation, and with sector 0 blank the
 * FreeDOS(98) kernel offers the partition no drive letter at all.
 *
 * `image` must already be `size` bytes of zeroes, `size` a whole number of
 * cylinders (mb * 1024 * 1024 rounded up to 512 * 25 * 8). Pass 0 for spc or
 * nroot to take the values BTNPART uses.
 */
EXPORT
int pc98fat_mkhdn(uint8_t *image, int size, const char *label,
                  const uint8_t *ipl, int iplsize, int spc_in, int nroot_in)
{
	uint32_t track = HDN_SECTOR * HDN_SPT * HDN_HEADS;
	uint32_t total, cylinders, start_cyl, end_cyl, hidden, part_sectors;
	uint32_t spc = spc_in > 0 ? (uint32_t)spc_in : 4;
	uint32_t nroot = nroot_in > 0 ? (uint32_t)nroot_in : 3072;
	uint32_t reserved = 2, root_sectors, clusters, spf;
	uint8_t *part;

	errbuf[0] = '\0';
	if (image == NULL || size <= 0) {
		set_err("no buffer");
		return PF_ERR_NOIMAGE;
	}
	total = (uint32_t)size;
	if (total % track) {
		set_err("size is not a whole number of cylinders");
		return PF_ERR_TOOSMALL;
	}
	cylinders = total / track;
	if (cylinders < 2) {
		set_err("too small");
		return PF_ERR_TOOSMALL;
	}

	/* Cylinder 0 holds the IPL and the partition table. */
	start_cyl = 1;
	end_cyl = cylinders - 1;
	hidden = start_cyl * HDN_SPT * HDN_HEADS;
	part_sectors = (end_cyl - start_cyl + 1) * HDN_SPT * HDN_HEADS;

	root_sectors = (nroot * 32 + HDN_SECTOR - 1) / HDN_SECTOR;
	clusters = (part_sectors - reserved - root_sectors) / spc;
	spf = ((clusters + 2) * 2 + HDN_SECTOR - 1) / HDN_SECTOR;
	/* spf feeds back into the cluster count; one pass is enough at these
	 * sizes, and the result is checked below. */
	clusters = (part_sectors - reserved - 2 * spf - root_sectors) / spc;
	if (clusters <= 4085 || clusters >= 65525) {
		set_err("cluster count is outside FAT16 - adjust the cluster size");
		return PF_ERR_TOOSMALL;
	}

	if (ipl != NULL && iplsize > 0) {
		uint32_t n = (uint32_t)iplsize < HDN_SECTOR
		           ? (uint32_t)iplsize : HDN_SECTOR;
		memcpy(image, ipl, n);
	}
	build_partition(image + HDN_SECTOR, start_cyl, end_cyl,
	                HDN_HEADS, HDN_SPT, label);

	part = image + hidden * HDN_SECTOR;
	build_bpb(part, HDN_SECTOR, spc, reserved, 2, nroot, part_sectors,
	          0xf8, spf, HDN_SPT, HDN_HEADS, hidden, label, 1);
	seed_fats(part, HDN_SECTOR, reserved, spf, 0xfe, 1);

	{
		uint8_t *root = part + (reserved + 2 * spf) * HDN_SECTOR;

		put_ascii(root, label, 11);
		root[11] = ATTR_VOLUME;
	}
	return PF_OK;
}

/* How big a .hdn of `mb` megabytes has to be: whole cylinders. */
EXPORT
int pc98fat_hdn_size(int mb)
{
	uint32_t track = HDN_SECTOR * HDN_SPT * HDN_HEADS;
	uint32_t want;

	if (mb <= 0) {
		return 0;
	}
	want = (uint32_t)mb * 1024u * 1024u;
	if (want % track) {
		want = (want / track + 1) * track;
	}
	return (int)want;
}

EXPORT int pc98fat_fd2hd_size(void) { return FD_2HD_SECTOR * FD_2HD_SECTORS; }

/* A blank PC-98 2HD (1.2MB) FAT12 floppy, the shape the FreeDOS(98) one has. */
EXPORT
int pc98fat_mkfd2hd(uint8_t *image, int size, const char *label)
{
	errbuf[0] = '\0';
	if (image == NULL || size != FD_2HD_SECTOR * FD_2HD_SECTORS) {
		set_err("a 2HD image is 1261568 bytes");
		return PF_ERR_TOOSMALL;
	}
	build_bpb(image, FD_2HD_SECTOR, 1, 1, 2, 192, FD_2HD_SECTORS,
	          0xfe, 2, 8, 2, 0, label, 0);
	seed_fats(image, FD_2HD_SECTOR, 1, 2, 0xfe, 0);
	{
		uint8_t *root = image + (1 + 2 * 2) * FD_2HD_SECTOR;

		put_ascii(root, label, 11);
		root[11] = ATTR_VOLUME;
	}
	return PF_OK;
}
