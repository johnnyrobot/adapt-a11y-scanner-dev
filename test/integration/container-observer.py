"""Read-only host observer: never changes the container's security policy."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

container, directory = sys.argv[1:]
directory = Path(directory)
deadline = time.monotonic() + 300
while time.monotonic() < deadline and not (directory / "observer-stop").exists():
    for request in directory.glob("*.request.json"):
        if not re.fullmatch(r"\d+-\d+-\d+\.request\.json", request.name):
            raise ValueError("invalid request filename")
        response = directory / request.name.replace(".request.", ".response.")
        if response.exists():
            continue
        data = json.loads(request.read_text())
        pid = data["pid"]
        assert type(pid) is int and pid > 0
        assert request.name == data["requestId"] + ".request.json"
        top = subprocess.run(["docker", "top", container, "-eo", "pid"],
                             check=True, capture_output=True, text=True).stdout
        matches = []
        for line in top.splitlines()[1:]:
            host_pid = int(line.strip())
            proc = Path("/proc") / str(host_pid)
            try:
                fields = dict(line.split(":", 1) for line in (proc / "status").read_text().splitlines())
                namespace_pids = list(map(int, fields["NSpid"].split()))
                # Host /proc starts with host PID, then this container's PID,
                # then any Chromium sandbox PID namespace. Never match the
                # renderer's innermost PID to an unrelated container process.
                if len(namespace_pids) < 2 or namespace_pids[1] != pid:
                    continue
                matches.append({"containerPid": pid, "hostPid": host_pid,
                                "requestId": data["requestId"],
                                "userNamespace": os.readlink(proc / "ns/user"),
                                "pidNamespace": os.readlink(proc / "ns/pid"),
                                "hostNamespacePids": namespace_pids})
            except FileNotFoundError:
                continue
        if not matches:
            continue
        assert len(matches) == 1, "ambiguous container PID"
        temporary = response.with_suffix(".tmp")
        temporary.write_text(json.dumps(matches[0]))
        temporary.chmod(0o644)
        temporary.replace(response)
    time.sleep(0.02)
if not (directory / "observer-stop").exists():
    raise TimeoutError("container proof did not finish within observer deadline")
