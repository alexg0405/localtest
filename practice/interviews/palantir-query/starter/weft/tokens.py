"""Splits query text into tokens: names, numbers, strings, $parameters, and operators."""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

from .errors import QueryError

OPERATORS = ("==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "(", ")", ",", "=")
ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "t": "\t"}


@dataclass(frozen=True)
class Token:
    kind: str      # "name", "number", "string", "param", "op", or "end"
    value: object  # the name or operator as written, the number, the string's text, or the parameter's name
    line: int
    column: int

    def is_word(self, *words: str) -> bool:
        """True if this is a name spelled like one of the keywords (keywords ignore case)."""
        return self.kind == "name" and str(self.value).lower() in words

    def is_op(self, *ops: str) -> bool:
        return self.kind == "op" and self.value in ops


def _is_name_start(ch: str) -> bool:
    return ch.isalpha() or ch == "_"


def _is_name_char(ch: str) -> bool:
    return ch.isalnum() or ch == "_"


def tokenize(text: str) -> List[Token]:
    tokens: List[Token] = []
    i, line, line_start = 0, 1, 0
    while i < len(text):
        ch, column = text[i], i - line_start + 1
        if ch == "\n":
            i, line, line_start = i + 1, line + 1, i + 1
        elif ch.isspace():
            i += 1
        elif ch == "#":   # a comment, to the end of the line
            while i < len(text) and text[i] != "\n":
                i += 1
        elif ch == '"':
            i, value = _string(text, i, line, column)
            tokens.append(Token("string", value, line, column))
        elif ch == "'":
            raise QueryError("strings use double quotes in Weft: write \"like this\", not 'like this'", line, column)
        elif ch.isdigit():
            start = i
            while i < len(text) and (text[i].isdigit() or (text[i] == "." and "." not in text[start:i])):
                i += 1
            number = text[start:i]
            tokens.append(Token("number", float(number) if "." in number else int(number), line, column))
        elif ch == "$":
            start = i = i + 1
            while i < len(text) and _is_name_char(text[i]):
                i += 1
            if i == start or not _is_name_start(text[start]):
                raise QueryError("$ starts a parameter, like $airport", line, column)
            tokens.append(Token("param", text[start:i], line, column))
        elif _is_name_start(ch):
            start = i
            while i < len(text) and (_is_name_char(text[i]) or (text[i] == "." and i + 1 < len(text) and _is_name_start(text[i + 1]))):
                i += 1
            tokens.append(Token("name", text[start:i], line, column))
        elif text.startswith("<>", i):
            raise QueryError("Weft writes 'not equal' as !=", line, column)
        else:
            op = next((op for op in OPERATORS if text.startswith(op, i)), None)
            if op is None:
                raise QueryError(f"unexpected character {ch!r}", line, column)
            tokens.append(Token("op", op, line, column))
            i += len(op)
    tokens.append(Token("end", "end of the query", line, len(text) - line_start + 1))
    return tokens


def _string(text: str, i: int, line: int, column: int):
    """The string starting at text[i] (a double quote): where it ends, and its value."""
    out, i = [], i + 1
    while i < len(text):
        ch = text[i]
        if ch == '"':
            return i + 1, "".join(out)
        if ch == "\n":
            break
        if ch == "\\" and i + 1 < len(text) and text[i + 1] in ESCAPES:
            out.append(ESCAPES[text[i + 1]])
            i += 2
            continue
        out.append(ch)
        i += 1
    raise QueryError("this string never ends: close it with a double quote on the same line", line, column)
