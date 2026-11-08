"""Turns query text into a Query: its table, its clauses in order, and the expressions inside them."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator, List, Optional, Tuple

from .errors import QueryError
from .tokens import Token, tokenize

CLAUSES = ("from", "latest", "join", "where", "group", "compute", "sort", "limit", "select")
ORDER = "from, latest, join, where, group by, compute, sort, limit, select"
AGGREGATES = ("count", "sum", "avg", "min", "max")
FUNCTIONS = {"hours_between": (2, 2), "lower": (1, 1), "round": (1, 2)}   # name: (fewest, most) arguments
KEYWORDS = set(CLAUSES) | {"by", "per", "on", "inner", "asc", "desc", "and", "or", "not", "is", "missing", "in", "true", "false"}
COMPARISONS = ("==", "!=", "<", "<=", ">", ">=")
# SQL habits, and what to write in Weft instead.
SQL_WORDS = {
    "order": "Weft sorts with `sort col`, not `order by` (section 8)",
    "left": "Weft joins keep unmatched rows already: write `join <table> on <col>`, or `join inner` to drop them (section 5)",
    "right": "Weft has no right join: start from the other table (section 5)",
    "having": "Weft has no `having` (section 4)",
    "as": "name a column with `name = ...` in compute or select, not `as` (sections 4 and 8)",
    "distinct": "Weft has no `distinct`: `group by` the columns instead (section 4)",
    "offset": "Weft has no `offset` (section 8)",
}


@dataclass
class Node:
    token: Token


@dataclass
class Literal(Node):
    value: Any


@dataclass
class Param(Node):
    name: str


@dataclass
class Column(Node):
    name: str


@dataclass
class Call(Node):
    name: str
    args: List[Node]


@dataclass
class Aggregate(Node):
    name: str
    arg: Optional[Node]   # None for count(*)


@dataclass
class Unary(Node):
    op: str               # "-" or "not"
    operand: Node


@dataclass
class Binary(Node):
    op: str               # arithmetic, a comparison, "and", or "or"
    left: Node
    right: Node


@dataclass
class IsMissing(Node):
    operand: Node
    negated: bool


@dataclass
class In(Node):
    operand: Node
    values: List[Node]
    negated: bool


@dataclass
class Join:
    table: Token
    on: Token
    inner: bool


@dataclass
class Query:
    table: Token
    latest: Optional[Tuple[List[Token], Token]] = None    # (keys, by)
    joins: List[Join] = field(default_factory=list)
    where: Optional[Node] = None
    group: Optional[List[Token]] = None
    compute: Optional[List[Tuple[Token, Node]]] = None
    sort: List[Tuple[Token, bool]] = field(default_factory=list)   # (column, descending)
    limit: Optional[Node] = None
    select: Optional[List[Tuple[str, Node]]] = None

    def expressions(self) -> Iterator[Node]:
        """Every expression in the query, for finding its columns and parameters."""
        if self.where is not None:
            yield self.where
        for _, node in self.compute or []:
            yield node
        if self.limit is not None:
            yield self.limit
        for _, node in self.select or []:
            yield node


def walk(node: Node) -> Iterator[Node]:
    """node and every node inside it."""
    yield node
    for child in (getattr(node, name, None) for name in ("operand", "left", "right", "arg")):
        if isinstance(child, Node):
            yield from walk(child)
    for child in getattr(node, "args", None) or getattr(node, "values", None) or []:
        yield from walk(child)


def parse(text: str) -> Query:
    return _Parser(tokenize(text)).query()


class _Parser:
    def __init__(self, tokens: List[Token]):
        self.tokens, self.pos = tokens, 0

    def peek(self, ahead: int = 0) -> Token:
        return self.tokens[min(self.pos + ahead, len(self.tokens) - 1)]

    def next(self) -> Token:
        token = self.peek()
        self.pos += 1
        return token

    def fail(self, message: str, token: Optional[Token] = None) -> QueryError:
        token = token or self.peek()
        return QueryError(message, token.line, token.column)

    def expect_word(self, word: str, after: str) -> Token:
        if not self.peek().is_word(word):
            raise self.fail(f"expected `{word}` after `{after}`, not `{self.peek().value}`")
        return self.next()

    def expect_op(self, op: str) -> Token:
        if not self.peek().is_op(op):
            raise self.fail(f"expected `{op}`, not `{self.peek().value}`")
        return self.next()

    def name(self, what: str = "a column name") -> Token:
        token = self.next()
        if token.kind == "param":
            raise self.fail(f"parameters are values, not names: ${token.value} can't stand for a column or table (section 7)", token)
        if token.kind != "name" or str(token.value).lower() in KEYWORDS:
            raise self.fail(f"expected {what}, not `{token.value}`", token)
        return token

    def names(self, what: str = "a column name") -> List[Token]:
        found = [self.name(what)]
        while self.peek().is_op(","):
            self.next()
            found.append(self.name(what))
        return found

    # Clauses

    def query(self) -> Query:
        first = self.peek()
        if not first.is_word("from"):
            extra = ": `select` goes last (section 2)" if first.is_word("select") else " (section 2)"
            raise self.fail("a Weft query starts with `from <table>`" + extra)
        self.next()
        query, last, seen = Query(self.name("a table name")), "from", {"from"}
        while self.peek().kind != "end":
            token = self.peek()
            word = str(token.value).lower() if token.kind == "name" else ""
            if word not in CLAUSES:
                hint = SQL_WORDS.get(word, f"clauses go in this order: {ORDER}")
                raise self.fail(f"expected the next clause, not `{token.value}`: {hint}")
            if word in seen and word != "join":
                raise self.fail(f"a query has at most one `{word}` clause")
            if CLAUSES.index(word) < CLAUSES.index(last):
                raise self.fail(f"`{word}` can't come after `{last}`: clauses go in this order: {ORDER} (section 2)")
            last = word
            seen.add(word)
            self.next()
            getattr(self, "clause_" + word)(query)
        return query

    def clause_latest(self, query: Query) -> None:
        self.expect_word("per", "latest")
        keys = self.names()
        self.expect_word("by", "latest per " + ", ".join(str(k.value) for k in keys))
        query.latest = (keys, self.name())

    def clause_join(self, query: Query) -> None:
        inner = self.peek().is_word("inner")
        if inner:
            self.next()
        table = self.name("a table name")
        self.expect_word("on", f"join {table.value}")
        query.joins.append(Join(table, self.name(), inner))

    def clause_where(self, query: Query) -> None:
        query.where = self.expression()

    def clause_group(self, query: Query) -> None:
        self.expect_word("by", "group")
        query.group = self.names()

    def clause_compute(self, query: Query) -> None:
        query.compute = []
        while True:
            name = self.name("a name for the computed column")
            self.expect_op("=")
            query.compute.append((name, self.expression(aggregates=True)))
            if not self.peek().is_op(","):
                return
            self.next()

    def clause_sort(self, query: Query) -> None:
        while True:
            column, descending = self.name(), False
            if self.peek().is_word("asc", "desc"):
                descending = self.next().is_word("desc")
            query.sort.append((column, descending))
            if not self.peek().is_op(","):
                return
            self.next()

    def clause_limit(self, query: Query) -> None:
        token = self.next()
        if token.kind == "param":
            query.limit = Param(token, str(token.value))
        elif token.kind == "number" and isinstance(token.value, int):
            query.limit = Literal(token, token.value)
        else:
            raise self.fail("limit takes a whole number or a $parameter", token)

    def clause_select(self, query: Query) -> None:
        query.select = []
        while True:
            if self.peek().kind == "name" and self.peek(1).is_op("="):
                name = self.name("a name for the column")
                self.next()
                query.select.append((str(name.value), self.expression()))
            else:
                column = self.name()
                query.select.append((str(column.value), Column(column, str(column.value))))
            if not self.peek().is_op(","):
                return
            self.next()

    # Expressions, loosest first: or, and, not, comparisons, + -, * /, unary minus, values.

    def expression(self, aggregates: bool = False) -> Node:
        self.aggregates = aggregates
        return self.or_()

    def or_(self) -> Node:
        node = self.and_()
        while self.peek().is_word("or"):
            node = Binary(self.next(), "or", node, self.and_())
        return node

    def and_(self) -> Node:
        node = self.not_()
        while self.peek().is_word("and"):
            node = Binary(self.next(), "and", node, self.not_())
        return node

    def not_(self) -> Node:
        if self.peek().is_word("not"):
            return Unary(self.next(), "not", self.not_())
        return self.comparison()

    def comparison(self) -> Node:
        left = self.sum()
        token = self.peek()
        if token.is_op("="):
            raise self.fail("use == to compare: a single = only names a column, in compute and select (section 3)")
        if token.kind == "op" and token.value in COMPARISONS:
            self.next()
            right = self.sum()
            for side in (left, right):
                if isinstance(side, Literal) and side.token.is_word("missing"):
                    raise self.fail("nothing is equal to missing: test for it with `is missing` or `is not missing` (section 3)", side.token)
            return Binary(token, str(token.value), left, right)
        if token.is_word("is"):
            self.next()
            negated = self.peek().is_word("not")
            if negated:
                self.next()
            self.expect_word("missing", "is not" if negated else "is")
            return IsMissing(token, left, negated)
        if token.is_word("in") or (token.is_word("not") and self.peek(1).is_word("in")):
            negated = self.next().is_word("not")
            if negated:
                self.next()
            self.expect_op("(")
            values = [self.sum()]
            while self.peek().is_op(","):
                self.next()
                values.append(self.sum())
            self.expect_op(")")
            return In(token, left, values, negated)
        return left

    def sum(self) -> Node:
        node = self.product()
        while self.peek().is_op("+", "-"):
            token = self.next()
            node = Binary(token, str(token.value), node, self.product())
        return node

    def product(self) -> Node:
        node = self.unary()
        while self.peek().is_op("*", "/"):
            token = self.next()
            node = Binary(token, str(token.value), node, self.unary())
        return node

    def unary(self) -> Node:
        if self.peek().is_op("-"):
            return Unary(self.next(), "-", self.unary())
        return self.value()

    def value(self) -> Node:
        token = self.next()
        if token.kind in ("number", "string"):
            return Literal(token, token.value)
        if token.kind == "param":
            return Param(token, str(token.value))
        if token.is_op("("):
            node = self.or_()
            self.expect_op(")")
            return node
        if token.kind != "name":
            raise self.fail(f"expected a value, not `{token.value}`", token)
        word = str(token.value).lower()
        if word in ("true", "false", "missing"):
            return Literal(token, {"true": True, "false": False, "missing": None}[word])
        if self.peek().is_op("("):
            return self.call(token, str(token.value))
        if word in KEYWORDS:
            raise self.fail(f"expected a value, not `{token.value}`", token)
        return Column(token, str(token.value))

    def call(self, token: Token, name: str) -> Node:
        self.next()   # the (
        if name in AGGREGATES:
            if not self.aggregates:
                raise self.fail(f"{name}() only works in compute (section 4)", token)
            if name == "count" and self.peek().is_op("*"):
                self.next()
                self.expect_op(")")
                return Aggregate(token, name, None)
            self.aggregates = False   # no aggregates inside aggregates
            arg = self.or_()
            self.aggregates = True
            self.expect_op(")")
            return Aggregate(token, name, arg)
        if name not in FUNCTIONS:
            raise self.fail(f"there's no function {name}(). Functions: {', '.join(FUNCTIONS)}; in compute: {', '.join(AGGREGATES)} (section 9)", token)
        args: List[Node] = []
        if not self.peek().is_op(")"):
            args.append(self.or_())
            while self.peek().is_op(","):
                self.next()
                args.append(self.or_())
        self.expect_op(")")
        fewest, most = FUNCTIONS[name]
        if not fewest <= len(args) <= most:
            expected = str(fewest) if fewest == most else f"{fewest} or {most}"
            raise self.fail(f"{name}() takes {expected} argument{'' if expected == '1' else 's'}, not {len(args)}", token)
        return Call(token, name, args)
