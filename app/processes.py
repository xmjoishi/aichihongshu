from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path


def popen_kwargs() -> dict:
    if sys.platform.startswith("win"):
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"preexec_fn": os.setsid}


def terminate_process_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if sys.platform.startswith("win"):
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
            timeout=5,
            check=False,
        )
        return
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)
    except Exception:
        proc.terminate()


def find_processes_by_marker(marker: str) -> list[str]:
    try:
        if sys.platform.startswith("win"):
            result = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    (
                        "Get-CimInstance Win32_Process | "
                        f"Where-Object {{$_.CommandLine -like '*{marker}*'}} | "
                        "Select-Object -ExpandProperty ProcessId"
                    ),
                ],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        else:
            result = subprocess.run(
                ["pgrep", "-f", marker],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
    except Exception:
        return []
    return [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]


def kill_processes_by_marker(marker: str) -> None:
    try:
        if sys.platform.startswith("win"):
            pids = find_processes_by_marker(marker)
            for pid in pids:
                subprocess.run(
                    ["taskkill", "/PID", pid, "/T", "/F"],
                    capture_output=True,
                    timeout=5,
                    check=False,
                )
        else:
            subprocess.run(
                ["pkill", "-f", marker],
                capture_output=True,
                timeout=5,
                check=False,
            )
    except Exception:
        pass


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path
