"""relay: run many small jobs at once on a few threads, with keys, retries, timeouts, and callbacks.

The docs are in DOCS.md, next to this file.
"""
from .core import Cancelled, Handle, JobFailed, Outcome, Retry, Runner, Tally, cancelled, gather

__all__ = ["Runner", "Handle", "Retry", "Outcome", "Tally", "JobFailed", "Cancelled", "gather", "cancelled"]
