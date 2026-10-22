#!/usr/bin/env python3
"""Keep core/ identical in hermes-sapgui and pi-sapgui.

    python3 scripts/sync-core.py                 # rewrite core/CHECKSUMS after editing core/
    python3 scripts/sync-core.py ../pi-sapgui    # copy this core/ into the other repository too

core/ is the bridge that runs inside SAP GUI plus the shared tool spec. Edit it
in one repository, run this script with the other repository as argument, and
commit both. The test suites of both repositories compare core/ with CHECKSUMS.
"""

import hashlib
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "core"


def write_checksums(core: Path) -> None:
    lines = []
    for path in sorted(p for p in core.rglob("*") if p.is_file() and p.name != "CHECKSUMS"):
        rel = path.relative_to(core).as_posix()
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {rel}")
    (core / "CHECKSUMS").write_text("\n".join(lines) + "\n")


def main() -> int:
    write_checksums(CORE)
    if len(sys.argv) > 1:
        other = Path(sys.argv[1]).resolve() / "core"
        if other.exists():
            shutil.rmtree(other)
        shutil.copytree(CORE, other)
        print(f"copied core/ to {other}")
    print("core/CHECKSUMS updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
