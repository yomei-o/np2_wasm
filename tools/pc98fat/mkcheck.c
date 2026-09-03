/* Does the C image builder agree with the JS/Python ones byte for byte? */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
extern int pc98fat_mkhdn(unsigned char *, int, const char *,
                         const unsigned char *, int, int, int);
extern int pc98fat_mkfd2hd(unsigned char *, int, const char *);
extern int pc98fat_hdn_size(int);
extern int pc98fat_fd2hd_size(void);
extern const char *pc98fat_error(void);

int main(int argc, char **argv)
{
	int mb = argc > 3 ? atoi(argv[3]) : 100;
	int size = pc98fat_hdn_size(mb);
	unsigned char *img = calloc(1, (size_t)size);
	unsigned char ipl[512];
	FILE *f = fopen(argv[1], "rb");
	int r;

	if (!f || fread(ipl, 1, 512, f) != 512) { puts("no IPL"); return 2; }
	fclose(f);
	r = pc98fat_mkhdn(img, size, argc > 4 ? argv[4] : "NP2WASM DATA",
	                  ipl, 512, 0, 0);
	if (r != 0) { printf("mkhdn failed: %s\n", pc98fat_error()); return 3; }
	f = fopen(argv[2], "wb");
	fwrite(img, 1, (size_t)size, f);
	fclose(f);
	printf("hdn %d bytes -> %s\n", size, argv[2]);
	free(img);

	size = pc98fat_fd2hd_size();
	img = calloc(1, (size_t)size);
	r = pc98fat_mkfd2hd(img, size, "BLANK");
	if (r != 0) { printf("mkfd2hd failed: %s\n", pc98fat_error()); return 4; }
	f = fopen("mk_blank.xdf", "wb");
	fwrite(img, 1, (size_t)size, f);
	fclose(f);
	printf("fd %d bytes -> mk_blank.xdf\n", size);
	return 0;
}
