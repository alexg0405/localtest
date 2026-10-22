from __future__ import annotations

from typing import List, Tuple

Record = Tuple[str, str, int, int]  # (package_id, carrier, promised_day, delivered_day)


def top_late_carriers(records: List[Record], k: int) -> List[str]:
    """Returns the k carriers with the most late packages, the most late first."""
    raise NotImplementedError
