#!/usr/bin/env python3
"""Compatibility entrypoint; the implementation belongs to the shared runtime."""
from pathlib import Path as _CompatibilityPath

_shared_bridge = _CompatibilityPath(__file__).resolve().parents[2] / "business" / "risk" / "direct_bridge.py"
# Execute in this module's globals so legacy import/patch users retain identical
# function-global semantics. No second backend/cache implementation is installed.
exec(compile(_shared_bridge.read_bytes(), str(_shared_bridge), "exec"), globals())
