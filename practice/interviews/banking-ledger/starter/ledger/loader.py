from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Union


def load_events(path: Union[str, Path]) -> List[Dict[str, Any]]:
    """Reads one JSON object per line, skipping blank lines."""
    events: List[Dict[str, Any]] = []
    with open(path, encoding="utf-8") as feed:
        for number, line in enumerate(feed, start=1):
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{number}: not valid JSON ({error.msg})") from None
    return events
