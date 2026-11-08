"""weft: a small query language for tables of rows. It looks like SQL, and isn't.

The docs are in DOCS.md, next to this file.
"""
from .engine import run
from .errors import QueryError

__all__ = ["run", "QueryError"]
