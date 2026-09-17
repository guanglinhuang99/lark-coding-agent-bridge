from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: stdio_server.py <risk-service-dir>")
    service_dir = Path(sys.argv[1]).resolve(strict=True)
    os.chdir(service_dir)
    sys.path.insert(0, str(service_dir))
    from app import create_unified_mcp

    # Local and remote expose the exact same unified core MCP contract.  Only
    # the transport differs; local has no HTTP or Connect authentication layer.
    create_unified_mcp(include_specialized_tools=False).run(
        transport="stdio",
        show_banner=False,
    )


if __name__ == "__main__":
    main()
