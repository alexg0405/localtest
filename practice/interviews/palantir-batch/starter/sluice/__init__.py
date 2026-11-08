"""sluice: run records through steps in batches, and write the results to tables.

The docs are in DOCS.md, next to this file.
"""
from .core import Count, DeadLetter, Max, Min, Pipeline, Record, RunFailed, RunReport, StepReport, Store, Sum, Table

__all__ = ["Pipeline", "Store", "Table", "Record", "Sum", "Count", "Min", "Max", "RunReport", "StepReport", "DeadLetter", "RunFailed"]
