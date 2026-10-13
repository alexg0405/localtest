from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from .registry import Context, get_stage


class PipelineError(Exception):
    pass


@dataclass
class Summary:
    rows_read: int
    items_written: int
    errors: List[str]


def run(config: Dict[str, Any]) -> Summary:
    context = Context(config=config)
    for name in config["stages"]:
        get_stage(name)(context)
    if context.rows_read and not context.items:
        shown = "; ".join(context.errors[:3])
        raise PipelineError(f"no valid rows in {config['input']} ({len(context.errors)} skipped: {shown})")
    return Summary(rows_read=context.rows_read, items_written=len(context.items), errors=list(context.errors))
