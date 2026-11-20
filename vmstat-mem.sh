#!/bin/sh
# Run `vmstat -n 1` and append two columns read from /proc/meminfo (in KiB):
#   total - MemTotal      (vmstat doesn't report total memory)
#   avail - MemAvailable  (memory available for new programs, as in `free`)
# The browser uses them to show used memory.

exec /usr/bin/vmstat -n 1 | awk '
NR == 1 { print; fflush(); next }
NR == 2 { print $0 "    total    avail"; fflush(); next }
{
    total = ""; avail = ""
    while ((getline line < "/proc/meminfo") > 0) {
        split(line, f, /[: ]+/)
        if (f[1] == "MemTotal") total = f[2]
        else if (f[1] == "MemAvailable") avail = f[2]
    }
    close("/proc/meminfo")
    printf "%s %8s %8s\n", $0, total, avail
    fflush()
}'
