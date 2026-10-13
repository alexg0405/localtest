from __future__ import annotations

import csv
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Dict

from .registry import Context, Row, stage


@stage("read_csv")
def read_csv(context: Context) -> None:
    options = context.config["options"]
    # Some export tools start UTF-8 files with a byte-order mark; utf-8-sig drops it if present.
    encoding = "utf-8-sig" if options["encoding"].lower().replace("_", "-") in ("utf-8", "utf8") else options["encoding"]
    with open(context.config["input"], newline="", encoding=encoding) as handle:
        reader = csv.DictReader(handle, delimiter=options.get("delimiter", ","))
        context.rows = [Row(line=reader.line_num, fields=dict(raw)) for raw in reader]
    context.rows_read = len(context.rows)


@stage("normalize_headers")
def normalize_headers(context: Context) -> None:
    for row in context.rows:
        row.fields = {str(key).strip().lower(): (value or "").strip() for key, value in row.fields.items()}


@stage("validate")
def validate(context: Context) -> None:
    required = context.config["options"]["required"]
    valid = []
    for row in context.rows:
        missing = [name for name in required if not row.fields.get(name)]
        if missing:
            context.errors.append(f"line {row.line}: missing {', '.join(missing)}")
            continue
        valid.append(row)
    context.rows = valid


def to_cents(text: str) -> int:
    """'12.50' -> 1250. Rejects negatives and more than two decimal places."""
    try:
        amount = Decimal(text)
    except InvalidOperation:
        raise ValueError(f"not a number: {text!r}") from None
    if not amount.is_finite() or amount < 0 or amount.as_tuple().exponent < -2:
        raise ValueError(f"not a valid price: {text!r}")
    return int(amount * 100)


@stage("parse_prices")
def parse_prices(context: Context) -> None:
    parsed = []
    for row in context.rows:
        try:
            row.fields["price_cents"] = to_cents(row.fields["price"])
        except ValueError as error:
            context.errors.append(f"line {row.line}: {error}")
            continue
        parsed.append(row)
    context.rows = parsed


@stage("dedupe")
def dedupe(context: Context) -> None:
    key = context.config["options"]["dedupe_key"]
    latest: Dict[str, Row] = {}
    for row in context.rows:
        latest[row.fields[key]] = row  # later rows win
    context.rows = [latest[value] for value in sorted(latest)]


@stage("write_json")
def write_json(context: Context) -> None:
    if context.rows_read and not context.rows:
        return  # Keep the last good catalog; the runner fails the run.
    context.items = [
        {"sku": row.fields["sku"], "name": row.fields["name"], "price_cents": row.fields["price_cents"]}
        for row in context.rows
    ]
    output = Path(context.config["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(context.items, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
