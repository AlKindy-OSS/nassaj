# T-2089 S0 probe: can a dsh tool child take its parent's fd 3 / fd 7 (pidfd_getfd) and read its memory?
import ctypes, os, stat, sys
libc = ctypes.CDLL(None, use_errno=True)
pid = int(sys.argv[1])
pidfd = libc.syscall(434, pid, 0)  # pidfd_open
print("pidfd_open", pidfd, os.strerror(ctypes.get_errno()) if pidfd < 0 else "ok")
for target in (3, 7):
    fd = libc.syscall(438, pidfd, target, 0)  # pidfd_getfd
    if fd < 0:
        print(f"getfd {target}: FAIL {os.strerror(ctypes.get_errno())}")
    else:
        st = os.fstat(fd)
        print(f"getfd {target}: OK socket={stat.S_ISSOCK(st.st_mode)} -> {os.readlink(f'/proc/self/fd/{fd}')}")
try:
    with open(f"/proc/{pid}/mem", "rb") as m:
        maps = open(f"/proc/{pid}/maps").readline().split()[0].split("-")
        m.seek(int(maps[0], 16)); print("mem read bytes:", len(m.read(16)))
except Exception as e:
    print("mem read FAIL", e)
