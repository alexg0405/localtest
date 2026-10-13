from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List


@dataclass
class Row:
    line: int  # line number in the CSV file; the header is line 1
    fields: Dict[str, Any]


@dataclass
class Context:
    config: Dict[str, Any]
    rows: List[Row] = field(default_factory=list)
    rows_read: int = 0
    items: List[Dict[str, Any]] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


Stage = Callable[[Context], None]
_STAGES: Dict[str, Stage] = {}


class UnknownStage(KeyError):
    def __str__(self) -> str:
        return str(self.args[0])


def stage(name: str) -> Callable[[Stage], Stage]:
    """Registers a stage function under `name`."""
    def register(function: Stage) -> Stage:
        _STAGES[name] = function
        return function
    return register


def get_stage(name: str) -> Stage:
    try:
        return _STAGES[name]
    except KeyError:
        raise UnknownStage(f"unknown stage {name!r}; known stages: {', '.join(sorted(_STAGES))}") from None
