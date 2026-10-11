"""Test-only PTY transport; receives input bytes on stdin and forwards output."""
import fcntl, os, pty, select, signal, struct, sys, termios, time
pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
# The child owns a fresh session/process group created by pty.fork().
sys.stderr.write("PI_GRAPH_TEST_PTY_PID=" + str(pid) + "\n")
sys.stderr.flush()
def stop(*args):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try: os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            if os.waitpid(pid, os.WNOHANG)[0]: break
        except ChildProcessError: break
        time.sleep(0.05)
    # Kill only this fixture's PTY process group, including remaining children.
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    try: os.close(master)
    except OSError: pass
    os._exit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while True:
        ready, _, _ = select.select([master, 0], [], [], 1)
        for fd in ready:
            try: data = os.read(fd, 65536)
            except OSError: stop()
            if not data: stop()
            os.write(1 if fd == master else master, data)
finally:
    stop()
