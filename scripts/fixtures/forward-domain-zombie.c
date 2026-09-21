#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>

/* IPC-controlled normal exit, retained by waitid(WNOWAIT) until explicitly reaped. */
int main(void) {
    int gate[2];
    if (pipe(gate) != 0) return 70;
    pid_t child = fork();
    if (child < 0) return 71;
    if (child == 0) {
        char signal;
        close(gate[1]);
        if (read(gate[0], &signal, 1) != 1) _exit(72);
        _exit(0);
    }
    close(gate[0]);
    printf("%ld\n", (long)child); fflush(stdout);
    char signal;
    if (read(STDIN_FILENO, &signal, 1) != 1) return 73;
    if (write(gate[1], "x", 1) != 1) return 74;
    close(gate[1]);
    siginfo_t info;
    if (waitid(P_PID, child, &info, WEXITED | WNOWAIT) != 0) return 75;
    puts("zombie"); fflush(stdout);
    if (read(STDIN_FILENO, &signal, 1) != 1) return 76;
    int status;
    if (waitpid(child, &status, 0) != child) return 77;
    return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 78;
}
