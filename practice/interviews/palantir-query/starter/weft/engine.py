"""Runs a parsed Query against tables of rows, one clause after another, in the fixed clause order."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .errors import QueryError
from .parser import Aggregate, Binary, Call, Column, In, IsMissing, Literal, Node, Param, Query, Unary, parse, walk
from .tokens import Token

Row = Dict[str, Any]


class Frame:
    """The rows between two clauses, and the columns they have (None when the table was empty, so nobody knows)."""

    def __init__(self, columns: Optional[List[str]], rows: List[Row], grouped: bool = False):
        self.columns, self.rows, self.grouped = columns, rows, grouped

    def check(self, token: Token, name: str, clause: str = "") -> None:
        if self.columns is None or name in self.columns:
            return
        after = ": after group by, only the group keys and the computed columns are left (section 4)" if self.grouped else ""
        raise QueryError(f"there's no column `{name}`{' in ' + clause if clause else ''}{after}. Columns here: {', '.join(self.columns) or '(none)'}",
                         token.line, token.column)

    def check_expression(self, node: Node) -> None:
        for inner in walk(node):
            if isinstance(inner, Column):
                self.check(inner.token, inner.name)


def run(query: str, tables: Mapping[str, Sequence[Mapping[str, Any]]], params: Optional[Mapping[str, Any]] = None) -> List[Row]:
    """Runs a Weft query against tables ({name: list of row dicts}) and returns the result as a list of row dicts.
    Missing values are None, both in the tables and in the result. Raises QueryError if anything is wrong."""
    parsed = parse(query)
    params = dict(params or {})
    for name, value in params.items():
        if value is not None and not isinstance(value, (str, int, float, bool)):
            raise QueryError(f"${name} must be text, a number, true or false, or None, not {type(value).__name__} (section 7)")
    for node in parsed.expressions():
        for inner in walk(node):
            if isinstance(inner, Param) and inner.name not in params:
                raise QueryError(f"there's no value for ${inner.name}: pass it in params (section 7)", inner.token.line, inner.token.column)
    return _Run(parsed, tables, params).rows()


class _Run:
    def __init__(self, query: Query, tables: Mapping[str, Sequence[Mapping[str, Any]]], params: Dict[str, Any]):
        self.query, self.tables, self.params = query, tables, params

    def table(self, token: Token) -> Frame:
        name = str(token.value)
        if name not in self.tables:
            raise QueryError(f"there's no table `{name}`. Tables: {', '.join(sorted(self.tables))}", token.line, token.column)
        rows = [dict(row) for row in self.tables[name]]
        columns: List[str] = []
        for row in rows:
            columns.extend(key for key in row if key not in columns)
        return Frame(columns if rows else None, [{c: row.get(c) for c in columns} for row in rows])

    def rows(self) -> List[Row]:
        q = self.query
        frame = self.table(q.table)
        if q.latest:
            frame = self.latest(frame, *q.latest)
        for join in q.joins:
            frame = self.join(frame, join.table, join.on, join.inner)
        if q.where is not None:
            frame.check_expression(q.where)
            frame.rows = [row for row in frame.rows if self.eval(q.where, row) is True]
        if q.group is not None or q.compute is not None:
            frame = self.group(frame, q.group or [], q.compute or [])
        if q.sort:
            frame = self.sort(frame)
        if q.limit is not None:
            count = self.eval(q.limit, {})
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise QueryError(f"limit needs a whole number, 0 or more, not {count!r}", q.limit.token.line, q.limit.token.column)
            frame.rows = frame.rows[:count]
        if q.select is not None:
            for _, node in q.select:
                frame.check_expression(node)
            seen = set()
            for name, node in q.select:
                if name in seen:
                    raise QueryError(f"`{name}` is selected twice", node.token.line, node.token.column)
                seen.add(name)
            return [{name: self.eval(node, row) for name, node in q.select} for row in frame.rows]
        return [dict(row) for row in frame.rows]

    # Clauses

    def latest(self, frame: Frame, keys: List[Token], by: Token) -> Frame:
        for token in keys + [by]:
            frame.check(token, str(token.value), "latest")
        names, column = [str(k.value) for k in keys], str(by.value)
        best: Dict[tuple, int] = {}
        for i, row in enumerate(frame.rows):
            key = tuple(row[name] for name in names)
            kept = best.get(key)
            if kept is None or self.later_or_same(frame.rows[kept][column], row[column], by):
                best[key] = i
        keep = set(best.values())
        return Frame(frame.columns, [row for i, row in enumerate(frame.rows) if i in keep])

    def later_or_same(self, old: Any, new: Any, token: Token) -> bool:
        """Whether a row whose `by` value is new replaces one whose value is old: a value beats missing, a larger value
        wins, and on a tie the row further down the table wins."""
        if new is None:
            return old is None
        return old is None or self.compare(">=", new, old, token)

    def join(self, frame: Frame, table: Token, on: Token, inner: bool) -> Frame:
        right = self.table(table)
        column = str(on.value)
        for side, label in ((frame, "the rows so far"), (right, f"`{table.value}`")):
            if side.columns is not None and column not in side.columns:
                raise QueryError(f"`on {column}` needs a `{column}` column on both sides, and {label} has none", on.line, on.column)
        left_columns = frame.columns or []
        renamed = {c: (f"{table.value}.{c}" if c in left_columns else c) for c in (right.columns or []) if c != column}
        matches: Dict[Any, List[Row]] = {}
        for row in right.rows:
            if row[column] is not None:   # missing never matches anything
                matches.setdefault(row[column], []).append(row)
        rows: List[Row] = []
        for row in frame.rows:
            found = matches.get(row[column]) if row[column] is not None else None
            if found:
                rows.extend({**row, **{new: match[old] for old, new in renamed.items()}} for match in found)
            elif not inner:
                rows.append({**row, **{new: None for new in renamed.values()}})
        columns = left_columns + list(renamed.values()) if frame.columns is not None else None
        return Frame(columns, rows)

    def group(self, frame: Frame, keys: List[Token], compute: List[Any]) -> Frame:
        names = [str(k.value) for k in keys]
        for token in keys:
            frame.check(token, str(token.value), "group by")
        result_columns = list(names)
        for token, node in compute:
            name = str(token.value)
            if name in result_columns:
                raise QueryError(f"`{name}` is already a column of the result", token.line, token.column)
            result_columns.append(name)
            self.check_compute(frame, node, names)
        groups: Dict[tuple, List[Row]] = {}
        for row in frame.rows:
            groups.setdefault(tuple(row[name] for name in names), []).append(row)
        if not names and not groups:
            groups[()] = []   # compute without group by: one row, even for no rows
        rows = []
        for key, members in groups.items():
            row = dict(zip(names, key))
            for token, node in compute:
                row[str(token.value)] = self.eval(node, row, members)
            rows.append(row)
        return Frame(result_columns, rows, grouped=True)

    def check_compute(self, frame: Frame, node: Node, keys: List[str]) -> None:
        """Columns inside an aggregate come from the rows; outside one, only the group keys are there."""
        if isinstance(node, Aggregate):
            if node.arg is not None:
                frame.check_expression(node.arg)
            return
        if isinstance(node, Column) and node.name not in keys:
            raise QueryError(f"`{node.name}` isn't a group key, so in compute it can only be used inside an aggregate, like max({node.name}) (section 4)",
                             node.token.line, node.token.column)
        for child in (getattr(node, name, None) for name in ("operand", "left", "right")):
            if isinstance(child, Node):
                self.check_compute(frame, child, keys)
        for child in getattr(node, "args", None) or getattr(node, "values", None) or []:
            self.check_compute(frame, child, keys)

    def sort(self, frame: Frame) -> Frame:
        rows = list(frame.rows)
        for token, descending in reversed(self.query.sort):
            name = str(token.value)
            frame.check(token, name, "sort")
            present = [row for row in rows if row[name] is not None]
            absent = [row for row in rows if row[name] is None]   # missing values go last, either way
            try:
                present.sort(key=lambda row: row[name], reverse=descending)
            except TypeError:
                raise QueryError(f"can't sort by `{name}`: it mixes text and numbers", token.line, token.column) from None
            rows = present + absent
        return Frame(frame.columns, rows, frame.grouped)

    # Expressions

    def eval(self, node: Node, row: Row, group: Optional[List[Row]] = None) -> Any:
        if isinstance(node, Literal):
            return node.value
        if isinstance(node, Param):
            return self.params[node.name]
        if isinstance(node, Column):
            return row[node.name]
        if isinstance(node, Aggregate):
            return self.aggregate(node, group or [])
        if isinstance(node, IsMissing):
            return (self.eval(node.operand, row, group) is None) != node.negated
        if isinstance(node, In):
            value = self.eval(node.operand, row, group)
            if value is None:
                return False   # like any comparison with missing, `not in` is false too
            found = any(self.compare("==", value, self.eval(v, row, group), v.token) for v in node.values)
            return found != node.negated
        if isinstance(node, Unary):
            value = self.eval(node.operand, row, group)
            if node.op == "not":
                return value is not True
            return None if value is None else -self.number(value, node.token)
        if isinstance(node, Binary):
            if node.op == "and":
                return self.eval(node.left, row, group) is True and self.eval(node.right, row, group) is True
            if node.op == "or":
                return self.eval(node.left, row, group) is True or self.eval(node.right, row, group) is True
            left, right = self.eval(node.left, row, group), self.eval(node.right, row, group)
            if node.op in ("+", "-", "*", "/"):
                return self.arithmetic(node.op, left, right, node.token)
            return self.compare(node.op, left, right, node.token)
        if isinstance(node, Call):
            return self.call(node, [self.eval(arg, row, group) for arg in node.args])
        raise AssertionError(f"unknown node {node!r}")

    @staticmethod
    def kind(value: Any) -> str:
        return "true/false" if isinstance(value, bool) else "a number" if isinstance(value, (int, float)) else "text"

    def compare(self, op: str, left: Any, right: Any, token: Token) -> bool:
        if left is None or right is None:
            return False   # any comparison with a missing value is false, != included
        if self.kind(left) != self.kind(right):
            raise QueryError(f"can't compare {self.kind(left)} with {self.kind(right)}", token.line, token.column)
        return {"==": left == right, "!=": left != right, "<": left < right, "<=": left <= right, ">": left > right, ">=": left >= right}[op]

    def number(self, value: Any, token: Token) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise QueryError(f"expected a number, not {value!r}", token.line, token.column)
        return value

    def arithmetic(self, op: str, left: Any, right: Any, token: Token) -> Any:
        if left is None or right is None:
            return None
        left, right = self.number(left, token), self.number(right, token)
        if op == "/":
            return None if right == 0 else left / right
        return left + right if op == "+" else left - right if op == "-" else left * right

    def aggregate(self, node: Aggregate, rows: List[Row]) -> Any:
        if node.arg is None:
            return len(rows)   # count(*): every row
        values = [value for value in (self.eval(node.arg, row) for row in rows) if value is not None]
        if node.name == "count":
            return len(values)
        if not values:
            return None
        if node.name in ("sum", "avg"):
            numbers = [self.number(value, node.token) for value in values]
            return sum(numbers) if node.name == "sum" else sum(numbers) / len(numbers)
        try:
            return min(values) if node.name == "min" else max(values)
        except TypeError:
            raise QueryError(f"{node.name}() can't mix text and numbers", node.token.line, node.token.column) from None

    def call(self, node: Call, args: List[Any]) -> Any:
        if node.name == "lower":
            if args[0] is None:
                return None
            if not isinstance(args[0], str):
                raise QueryError(f"lower() needs text, not {args[0]!r}", node.token.line, node.token.column)
            return args[0].lower()
        if node.name == "round":
            if args[0] is None:
                return None
            digits = args[1] if len(args) > 1 else 0
            if isinstance(digits, bool) or not isinstance(digits, int):
                raise QueryError("round()'s second argument is a whole number of decimal places", node.token.line, node.token.column)
            return round(self.number(args[0], node.token), digits)
        # hours_between(start, end)
        if args[0] is None or args[1] is None:
            return None
        start, end = (self.timestamp(value, node.token) for value in args)
        return (end - start).total_seconds() / 3600

    @staticmethod
    def timestamp(value: Any, token: Token) -> datetime:
        try:
            return datetime.fromisoformat(value)
        except (TypeError, ValueError):
            raise QueryError(f"hours_between() needs ISO times like \"2026-10-12T06:05\", not {value!r}", token.line, token.column) from None
