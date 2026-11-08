"""The one exception Weft raises."""
from __future__ import annotations

from typing import Optional


class QueryError(Exception):
    """Something is wrong with a query: its text, its clauses, a column or table it names, or a parameter.

    .line and .column point at the place in the query text (both count from 1), or are None when the problem isn't
    at one place (a parameter with the wrong type, say).
    """

    def __init__(self, message: str, line: Optional[int] = None, column: Optional[int] = None):
        self.message, self.line, self.column = message, line, column
        super().__init__(f"{message} (line {line}, column {column})" if line is not None else message)
