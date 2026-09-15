"""Read macOS argv via KERN_PROCARGS2, stopping before environment variables."""

import ctypes
import json
import sys

MAX_BYTES = 1024 * 1024
MAX_ARGS = 4096


def decode_procargs(raw):
    if len(raw) < 4 or len(raw) > MAX_BYTES:
        raise ValueError("Invalid process argument size")
    argc = int.from_bytes(raw[:4], sys.byteorder, signed=True)
    if not 1 <= argc <= MAX_ARGS:
        raise ValueError("Invalid argument count")
    pos = raw.index(b"\0", 4) + 1
    # The executable path is followed by alignment padding, then argv[0].
    while pos < len(raw) and raw[pos] == 0:
        pos += 1
    args = []
    for _ in range(argc):
        end = raw.index(b"\0", pos)
        args.append(raw[pos:end].decode("utf-8", errors="strict"))
        pos = end + 1
    return args


def main():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                           ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                           ctypes.c_void_p, ctypes.c_size_t]
    libc.sysctl.restype = ctypes.c_int
    libc.sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p,
                                 ctypes.POINTER(ctypes.c_size_t),
                                 ctypes.c_void_p, ctypes.c_size_t]
    libc.sysctlbyname.restype = ctypes.c_int
    argmax = ctypes.c_int()
    size = ctypes.c_size_t(ctypes.sizeof(argmax))
    if libc.sysctlbyname(b"kern.argmax", ctypes.byref(argmax), ctypes.byref(size), None, 0):
        raise OSError("Cannot query kern.argmax")
    if not 4 <= argmax.value <= MAX_BYTES:
        raise ValueError("Unsupported kern.argmax")
    records = {}
    for value in sys.argv[1:]:
        pid = int(value)
        if not 1 < pid <= 2147483647:
            raise ValueError("Invalid process ID")
        try:
            data = ctypes.create_string_buffer(argmax.value)
            size = ctypes.c_size_t(len(data))
            mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
            if libc.sysctl(mib, 3, data, ctypes.byref(size), None, 0):
                raise OSError("Cannot query process arguments")
            records[value] = {"args": decode_procargs(data.raw[:size.value])}
        except (OSError, ValueError):
            records[value] = {"error": "Native process arguments are unavailable"}
    print(json.dumps(records))


if __name__ == "__main__":
    main()
