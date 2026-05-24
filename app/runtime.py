from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Sequence


def get_project_root() -> Path:
    override = os.getenv("RN_PROJECT_ROOT")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parent.parent


PROJECT_ROOT = get_project_root()
APP_ROOT = PROJECT_ROOT / "app"
CRAWLER_ROOT = PROJECT_ROOT / "crawler"
DATA_ROOT = PROJECT_ROOT / "data"
ASSETS_ROOT = PROJECT_ROOT / os.getenv("ASSETS_DIR", "assets")
ENV_PATH = PROJECT_ROOT / ".env"
MEDIA_CRAWLER_DIR = PROJECT_ROOT / "tools" / "MediaCrawler"


def get_media_crawler_python() -> str:
    if sys.platform.startswith("win"):
        candidate = MEDIA_CRAWLER_DIR / ".venv" / "Scripts" / "python.exe"
    else:
        candidate = MEDIA_CRAWLER_DIR / ".venv" / "bin" / "python"
    return str(candidate) if candidate.exists() else sys.executable


def get_media_crawler_uv() -> str:
    if sys.platform.startswith("win"):
        candidate = MEDIA_CRAWLER_DIR / ".venv" / "Scripts" / "uv.exe"
    else:
        candidate = MEDIA_CRAWLER_DIR / ".venv" / "bin" / "uv"
    return str(candidate) if candidate.exists() else "uv"


def build_python_script_cmd(script_path: Path, *args: str, python_exe: str | None = None) -> list[str]:
    return [python_exe or sys.executable, str(script_path), *args]


def command_display(cmd: Sequence[str]) -> str:
    return " ".join(str(part) for part in cmd)
