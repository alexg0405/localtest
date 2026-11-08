"""Runs the queries in queries.py and lays out their results for the operations dashboard.

In production, run() sends the query and its parameters to the warehouse, which runs Weft next to the data. Here it
runs them on the sample tables, with the same Weft.
"""
from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import weft

from . import sample

Query = Tuple[str, Dict[str, Any]]   # what each function in queries.py returns: the Weft text, and its parameters
Rows = List[Dict[str, Any]]


def run(query: Query, tables: Optional[Mapping[str, Sequence[Mapping[str, Any]]]] = None) -> Rows:
    """The rows a query returns, against the sample tables unless you pass others."""
    text, params = query
    return weft.run(text, sample.tables() if tables is None else tables, params=params)


def show(rows: Rows) -> str:
    """The rows as a text table, the way the dashboard shows them. Missing values show as a dash. Prints it too."""
    if not rows:
        text = "(no rows)"
    else:
        columns = list(rows[0])
        cells = [[("-" if row.get(c) is None else str(row.get(c))) for c in columns] for row in rows]
        widths = [max(len(c), *(len(line[i]) for line in cells)) for i, c in enumerate(columns)]
        lines = ["  ".join(c.ljust(w) for c, w in zip(columns, widths)), "  ".join("-" * w for w in widths)]
        lines += ["  ".join(cell.ljust(w) for cell, w in zip(line, widths)) for line in cells]
        text = "\n".join(lines)
    print(text)
    return text
