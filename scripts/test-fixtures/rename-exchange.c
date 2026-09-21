#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1U << 1)
#endif

int main(int argc, char **argv) {
    if (argc != 6 || strcmp(argv[1], "--exchange") != 0
        || strcmp(argv[2], "--no-copy") != 0 || strcmp(argv[3], "-T") != 0) {
        fputs("usage: rename-exchange --exchange --no-copy -T LEFT RIGHT\n", stderr);
        return 64;
    }
    if (syscall(SYS_renameat2, AT_FDCWD, argv[4], AT_FDCWD, argv[5], RENAME_EXCHANGE) != 0) {
        fprintf(stderr, "renameat2 exchange failed: %s\n", strerror(errno));
        return 1;
    }
    return 0;
}
