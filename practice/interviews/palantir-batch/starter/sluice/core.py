"""sluice's implementation. DOCS.md describes how to use it; you shouldn't need to read this file."""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from itertools import islice
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Tuple, Union

ERROR_POLICIES = ("fail", "skip", "dead_letter")
SINK_MODES = ("append", "upsert", "replace")
SCOPES = ("batch", "run")


class Record(Mapping):
    """A record as a step sees it: read-only. Return a new dict to change anything."""

    __slots__ = ("_data",)

    def __init__(self, data: Mapping):
        self._data = dict(data)

    def __getitem__(self, field: str) -> Any:
        return self._data[field]

    def __iter__(self) -> Iterator[str]:
        return iter(self._data)

    def __len__(self) -> int:
        return len(self._data)

    def __repr__(self) -> str:
        return f"Record({self._data!r})"

    def _read_only(self, *args: Any, **kwargs: Any) -> None:
        raise TypeError("sluice records are read-only: return a new dict instead, such as {**record, 'field': value}")

    __setitem__ = __delitem__ = pop = popitem = setdefault = update = clear = _read_only

    def replace(self, **changes: Any) -> Dict[str, Any]:
        """A new dict: this record's fields, with `changes` applied."""
        return {**self._data, **changes}


# Aggregations: each keeps a running state per group.

class Sum:
    def __init__(self, field: str):
        self.field = field

    def start(self) -> Any:
        return 0

    def add(self, state: Any, record: Record) -> Any:
        return state + record[self.field]


class Count:
    def start(self) -> Any:
        return 0

    def add(self, state: Any, record: Record) -> Any:
        return state + 1


class Min:
    def __init__(self, field: str):
        self.field = field

    def start(self) -> Any:
        return None

    def add(self, state: Any, record: Record) -> Any:
        value = record[self.field]
        return value if state is None or value < state else state


class Max(Min):
    def add(self, state: Any, record: Record) -> Any:
        value = record[self.field]
        return value if state is None or value > state else state


AGGREGATIONS = (Sum, Count, Min, Max)


# What a run reports.

@dataclass
class StepReport:
    name: str
    kind: str
    records_in: int = 0
    records_out: int = 0
    skipped: int = 0
    dead_lettered: int = 0


@dataclass(frozen=True)
class DeadLetter:
    step: str              # the step's name
    record: Record         # the record that step failed on
    error: BaseException   # what it raised


class RunReport:
    """What one run did: records read, batches, each step's counts, rows written, and dead letters."""

    def __init__(self, name: str, steps: List[StepReport]):
        self.name = name
        self.read = 0
        self.batches = 0
        self.written = 0
        self.steps = steps
        self.dead_letters: List[DeadLetter] = []
        self.output: List[Dict[str, Any]] = []

    @property
    def skipped(self) -> int:
        return sum(step.skipped for step in self.steps)

    def step(self, name: str) -> StepReport:
        for step in self.steps:
            if step.name == name:
                return step
        raise KeyError(f"no step named {name!r}: the steps are {', '.join(s.name for s in self.steps)}")

    def __str__(self) -> str:
        lines = [f"{self.name}: read {self.read} records in {self.batches} batches, wrote {self.written} rows",
                 f"  {'step':<14} {'kind':<10} {'in':>6} {'out':>6} {'skipped':>8} {'dead letters':>13}"]
        lines += [f"  {s.name:<14} {s.kind:<10} {s.records_in:>6} {s.records_out:>6} {s.skipped:>8} {s.dead_lettered:>13}" for s in self.steps]
        return "\n".join(lines)

    __repr__ = __str__


class RunFailed(Exception):
    """A step raised under on_error="fail" (or a sink couldn't write), so the run stopped."""

    def __init__(self, step: str, record: Record, cause: BaseException, report: RunReport):
        super().__init__(f"step {step!r} raised {type(cause).__name__}: {cause} (on {dict(record)!r})")
        self.step, self.record, self.cause, self.report = step, record, cause, report


class _Abort(Exception):
    def __init__(self, step: str, record: Record, cause: BaseException):
        super().__init__(step)
        self.step, self.record, self.cause = step, record, cause


# Tables

class Table:
    """Rows in memory. Sinks write them; rows() and find() read copies."""

    def __init__(self, name: str):
        self.name = name
        self._rows: List[Dict[str, Any]] = []

    def rows(self) -> List[Dict[str, Any]]:
        return [dict(row) for row in self._rows]

    def find(self, **fields: Any) -> List[Dict[str, Any]]:
        return [dict(row) for row in self._rows if all(field in row and row[field] == value for field, value in fields.items())]

    def __len__(self) -> int:
        return len(self._rows)

    def __repr__(self) -> str:
        return f"<sluice.Table {self.name!r}, {len(self._rows)} rows>"

    def _write(self, row: Dict[str, Any], mode: str, key: Tuple[str, ...]) -> None:
        if mode == "upsert":
            wanted = tuple(row[field] for field in key)   # KeyError if the record lacks a key field
            for i, existing in enumerate(self._rows):
                if all(field in existing for field in key) and tuple(existing[field] for field in key) == wanted:
                    self._rows[i] = row
                    return
        self._rows.append(row)


class Store:
    """A set of named tables."""

    def __init__(self) -> None:
        self._tables: Dict[str, Table] = {}

    def table(self, name: str) -> Table:
        if name not in self._tables:
            self._tables[name] = Table(name)
        return self._tables[name]

    def tables(self) -> List[str]:
        return sorted(self._tables)


# Steps

class _Step:
    kind = "step"

    def __init__(self, name: str, on_error: str = "fail"):
        if on_error not in ERROR_POLICIES:
            raise ValueError(f"on_error must be one of {', '.join(ERROR_POLICIES)}, not {on_error!r}")
        self.name, self.on_error = name, on_error

    def reset(self) -> None:
        pass

    def failed(self, record: Record, error: Exception, counts: StepReport, report: RunReport) -> None:
        if self.on_error == "fail":
            raise _Abort(self.name, record, error)
        if self.on_error == "skip":
            counts.skipped += 1
        else:
            counts.dead_lettered += 1
            report.dead_letters.append(DeadLetter(self.name, record, error))


class _Map(_Step):
    kind = "map"

    def __init__(self, fn: Callable[[Record], Mapping], name: str, on_error: str):
        super().__init__(name, on_error)
        self.fn = fn

    def apply(self, records: List[Record], counts: StepReport, report: RunReport) -> List[Record]:
        out = []
        for record in records:
            try:
                new = self.fn(record)
                if not isinstance(new, Mapping):
                    raise TypeError(f"map step {self.name!r} must return a dict, not {type(new).__name__}")
                out.append(Record(new))
            except Exception as error:  # noqa: BLE001 - the step's error policy decides
                self.failed(record, error, counts, report)
        counts.records_in += len(records)
        counts.records_out += len(out)
        return out


class _Filter(_Map):
    kind = "filter"

    def apply(self, records: List[Record], counts: StepReport, report: RunReport) -> List[Record]:
        out = []
        for record in records:
            try:
                if self.fn(record):
                    out.append(record)
            except Exception as error:  # noqa: BLE001
                self.failed(record, error, counts, report)
        counts.records_in += len(records)
        counts.records_out += len(out)
        return out


class _Aggregate(_Step):
    kind = "aggregate"

    def __init__(self, by: Tuple[str, ...], fields: Dict[str, Any], scope: str, name: str, on_error: str):
        super().__init__(name, on_error)
        if scope not in SCOPES:
            raise ValueError(f"scope must be 'batch' or 'run', not {scope!r}")
        for field, aggregation in fields.items():
            if not isinstance(aggregation, AGGREGATIONS):
                raise TypeError(f"aggregate field {field!r} must be sluice.Sum, Count, Min, or Max, not {aggregation!r}")
        self.by, self.fields, self.scope = by, fields, scope
        self.groups: Dict[tuple, List[Any]] = {}

    def reset(self) -> None:
        self.groups = {}

    def collect(self, records: List[Record], counts: StepReport, report: RunReport) -> None:
        for record in records:
            try:
                group = tuple(record[field] for field in self.by)
                states = self.groups.get(group) or [aggregation.start() for aggregation in self.fields.values()]
                self.groups[group] = [aggregation.add(state, record) for aggregation, state in zip(self.fields.values(), states)]
            except Exception as error:  # noqa: BLE001
                self.failed(record, error, counts, report)
        counts.records_in += len(records)

    def emit(self, counts: StepReport) -> List[Record]:
        out = [Record({**dict(zip(self.by, group)), **dict(zip(self.fields, states))}) for group, states in self.groups.items()]
        self.groups = {}
        counts.records_out += len(out)
        return out

    def apply(self, records: List[Record], counts: StepReport, report: RunReport) -> List[Record]:
        self.collect(records, counts, report)
        return self.emit(counts) if self.scope == "batch" else []


class _Sink(_Step):
    kind = "sink"

    def __init__(self, table: Table, mode: str, key: Tuple[str, ...], name: str):
        super().__init__(name)
        self.table, self.mode, self.key = table, mode, key

    def apply(self, records: List[Record], counts: StepReport, report: RunReport) -> List[Record]:
        for record in records:
            try:
                self.table._write(dict(record), self.mode, self.key)
            except Exception as error:  # noqa: BLE001 - a sink has no error policy: it always fails the run
                raise _Abort(self.name, record, error)
            counts.records_in += 1
            counts.records_out += 1
            report.written += 1
        return []


def _chunks(source: Iterable[Mapping], size: int) -> Iterator[List[Mapping]]:
    iterator = iter(source)
    while True:
        chunk = list(islice(iterator, size))
        if not chunk:
            return
        yield chunk


class Pipeline:
    """Steps over a source of records. Building one does nothing: run() reads the source and runs the steps."""

    def __init__(self, source: Union[Iterable[Mapping], Callable[[], Iterable[Mapping]]], batch_size: int = 1000, name: str = "pipeline"):
        if batch_size < 1:
            raise ValueError("batch_size must be at least 1")
        self._source, self.batch_size, self.name = source, batch_size, name
        self._steps: List[_Step] = []

    def __repr__(self) -> str:
        return f"<sluice.Pipeline {self.name!r}: {' -> '.join(s.name for s in self._steps) or 'no steps'}>"

    def _add(self, step: _Step) -> "Pipeline":
        if self._steps and isinstance(self._steps[-1], _Sink):
            raise ValueError("a pipeline's sink must be its last step")
        self._steps.append(step)
        return self

    def map(self, fn: Callable[[Record], Mapping], name: Optional[str] = None, on_error: str = "fail") -> "Pipeline":
        return self._add(_Map(fn, name or _name(fn, "map"), on_error))

    def filter(self, fn: Callable[[Record], Any], name: Optional[str] = None, on_error: str = "fail") -> "Pipeline":
        return self._add(_Filter(fn, name or _name(fn, "filter"), on_error))

    def aggregate(self, by: Union[str, Tuple[str, ...]], scope: str = "batch", name: str = "aggregate", on_error: str = "fail", **fields: Any) -> "Pipeline":
        if not fields:
            raise ValueError("aggregate needs at least one field, such as total=sluice.Sum('amount')")
        return self._add(_Aggregate(_fields(by), fields, scope, name, on_error))

    def sink(self, table: Table, mode: str = "append", key: Union[str, Tuple[str, ...], None] = None, name: str = "sink") -> "Pipeline":
        if mode not in SINK_MODES:
            raise ValueError(f"mode must be one of {', '.join(SINK_MODES)}, not {mode!r}")
        if (mode == "upsert") != (key is not None):
            raise ValueError("mode='upsert' needs a key, and only upsert takes one")
        return self._add(_Sink(table, mode, _fields(key) if key is not None else (), name))

    def run(self) -> RunReport:
        steps = self._steps
        report = RunReport(self.name, [StepReport(step.name, step.kind) for step in steps])
        for step in steps:
            step.reset()
        has_sink = bool(steps) and isinstance(steps[-1], _Sink)
        if has_sink and steps[-1].mode == "replace":
            steps[-1].table._rows.clear()
        source = self._source() if callable(self._source) else self._source
        try:
            for chunk in _chunks(source, self.batch_size):
                report.batches += 1
                report.read += len(chunk)
                self._push([Record(record) for record in chunk], 0, report, has_sink)
            for i, step in enumerate(steps):   # the end of the run: scope="run" aggregates emit, in order
                if isinstance(step, _Aggregate) and step.scope == "run":
                    self._push(step.emit(report.steps[i]), i + 1, report, has_sink)
        except _Abort as abort:
            raise RunFailed(abort.step, abort.record, abort.cause, report) from abort.cause
        return report

    def _push(self, records: List[Record], start: int, report: RunReport, has_sink: bool) -> None:
        for i in range(start, len(self._steps)):
            step = self._steps[i]
            records = step.apply(records, report.steps[i], report)
            if isinstance(step, _Aggregate) and step.scope == "run":
                return
        if not has_sink:
            report.output.extend(dict(record) for record in records)


def _name(fn: Callable[..., Any], default: str) -> str:
    name = getattr(fn, "__name__", default)
    return default if name == "<lambda>" else name


def _fields(fields: Union[str, Tuple[str, ...], List[str]]) -> Tuple[str, ...]:
    return (fields,) if isinstance(fields, str) else tuple(fields)
