/*
 * Native self test for pc98fat.c. Builds with any C compiler and runs against
 * real images, so the logic is checked before it ever goes near wasm.
 *
 *   cc -o selftest selftest.c pc98fat.c
 *   ./selftest ../../web/disk/fd98_2hd.img
 *   ./selftest hd100.hdn
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern int pc98fat_open(unsigned char *image, int size);
extern int pc98fat_volume_offset(void);
extern int pc98fat_bytes_per_sector(void);
extern int pc98fat_cluster_size(void);
extern int pc98fat_fat_bits(void);
extern int pc98fat_cluster_count(void);
extern const char *pc98fat_error(void);
extern int pc98fat_list(const char *path);
extern const char *pc98fat_listing(void);
extern int pc98fat_size(const char *path);
extern int pc98fat_read(const char *path, unsigned char *out, int outsize);
extern int pc98fat_write(const char *path, const unsigned char *data, int size);
extern int pc98fat_delete(const char *path);
extern int pc98fat_mkdir(const char *path);
extern double pc98fat_free_bytes(void);
extern double pc98fat_total_bytes(void);

static int failures;

static void check(int cond, const char *what)
{
	printf("  %-46s %s\n", what, cond ? "ok" : "FAILED");
	if (!cond) {
		failures++;
		if (pc98fat_error()[0]) {
			printf("      error: %s\n", pc98fat_error());
		}
	}
}

int main(int argc, char **argv)
{
	FILE *f;
	long size;
	unsigned char *img;
	int i;

	if (argc < 2) {
		fprintf(stderr, "usage: selftest <image> [more images...]\n");
		return 2;
	}

	for (i = 1; i < argc; i++) {
		printf("=== %s\n", argv[i]);
		f = fopen(argv[i], "rb");
		if (!f) {
			perror(argv[i]);
			failures++;
			continue;
		}
		fseek(f, 0, SEEK_END);
		size = ftell(f);
		fseek(f, 0, SEEK_SET);
		img = malloc((size_t)size);
		if (!img || fread(img, 1, (size_t)size, f) != (size_t)size) {
			fprintf(stderr, "could not read %s\n", argv[i]);
			failures++;
			fclose(f);
			free(img);
			continue;
		}
		fclose(f);

		check(pc98fat_open(img, (int)size) == 0, "open");
		printf("      volume at 0x%x, %d bytes/sector, cluster %d, FAT%d, %d clusters\n",
		       pc98fat_volume_offset(), pc98fat_bytes_per_sector(),
		       pc98fat_cluster_size(), pc98fat_fat_bits(),
		       pc98fat_cluster_count());
		printf("      %.0f of %.0f bytes free\n",
		       pc98fat_free_bytes(), pc98fat_total_bytes());

		{
			int n = pc98fat_list("/");
			/* A freshly formatted volume holds only its label, which the
			 * listing deliberately skips - so 0 is a pass, an error is not. */
			check(n >= 0, "list root");
			printf("      %d entries\n", n);
			{
				const char *p = pc98fat_listing();
				int shown = 0;
				while (*p && shown < 6) {
					const char *nl = strchr(p, '\n');
					printf("        %.*s\n", (int)(nl ? nl - p : strlen(p)), p);
					if (!nl) break;
					p = nl + 1;
					shown++;
				}
			}
		}

		/* round trip a file */
		{
			static const char text[] =
				"/* written by pc98fat selftest */\n"
				"#include <stdio.h>\n"
				"int main(void){ printf(\"hi\\n\"); return 0; }\n";
			unsigned char back[512];
			int wrote, got;

			wrote = pc98fat_write("/PF_TEST.C", (const unsigned char *)text,
			                      (int)strlen(text));
			check(wrote == (int)strlen(text), "write /PF_TEST.C");
			check(pc98fat_size("/PF_TEST.C") == (int)strlen(text),
			      "size of /PF_TEST.C");
			got = pc98fat_read("/PF_TEST.C", back, sizeof(back));
			check(got == (int)strlen(text)
			      && memcmp(back, text, strlen(text)) == 0,
			      "read back /PF_TEST.C");

			check(pc98fat_mkdir("/PFDIR") == 0, "mkdir /PFDIR");
			check(pc98fat_write("/PFDIR/INNER.TXT",
			                    (const unsigned char *)"inner\n", 6) == 6,
			      "write into the subdirectory");
			got = pc98fat_read("/PFDIR/INNER.TXT", back, sizeof(back));
			check(got == 6 && memcmp(back, "inner\n", 6) == 0,
			      "read back from the subdirectory");
			check(pc98fat_list("/PFDIR") == 1, "list the subdirectory");

			check(pc98fat_delete("/PFDIR") != 0, "refuse to delete a non-empty dir");
			check(pc98fat_delete("/PFDIR/INNER.TXT") == 0, "delete the inner file");
			check(pc98fat_delete("/PFDIR") == 0, "delete the empty dir");
			check(pc98fat_delete("/PF_TEST.C") == 0, "delete /PF_TEST.C");
			check(pc98fat_size("/PF_TEST.C") < 0, "gone after delete");
		}

		/* write the modified image out so it can be booted */
		{
			char out[512];
			const char *slash = strrchr(argv[i], '/');
			snprintf(out, sizeof(out), "pf_%s",
			         slash ? slash + 1 : argv[i]);
			f = fopen(out, "wb");
			if (f) {
				fwrite(img, 1, (size_t)size, f);
				fclose(f);
				printf("      wrote %s\n", out);
			}
		}
		free(img);
	}

	printf("%s\n", failures ? "FAILURES" : "all checks passed");
	return failures ? 1 : 0;
}
