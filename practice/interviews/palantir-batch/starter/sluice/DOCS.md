# sluice

sluice runs records through a few steps, in batches, and writes the results
to tables. Our deployment teams use it for the nightly jobs that turn a
customer's raw exports into something their other systems read in the
morning: it adds the parts a plain loop leaves to you, such as batching,
per-step error handling, safe re-runs, and a report of what happened.

It is an internal library shared by several deployments. Use it as it is.

## Contents

1. The basics
2. Batches
3. Records and steps: `map` and `filter`
4. Aggregating
5. Sinks and tables
6. Errors
7. The run report
8. Exceptions

## 1. The basics

```python
import sluice

orders = [{"store": "north", "amount": 12}, {"store": "south", "amount": 30}]
store = sluice.Store()

pipeline = (sluice.Pipeline(orders, batch_size=500, name="big_orders")
            .filter(lambda order: order["amount"] > 20)
            .map(lambda order: {**order, "flagged": True})
            .sink(store.table("big_orders")))

report = pipeline.run()
print(store.table("big_orders").rows())   # [{'store': 'south', 'amount': 30, 'flagged': True}]
```

- `sluice.Pipeline(source, batch_size=1000, name="pipeline")`. The source is
  a list (or any iterable) of dicts, or a function that returns one.
- `.map`, `.filter`, `.aggregate`, and `.sink` each add a step and return the
  pipeline, so you can chain them. Steps run in the order you added them.
- **Pipelines are lazy.** Building one reads nothing and calls none of your
  functions. Everything happens in **`run()`**, which returns a
  **RunReport** (section 7).
- You can call `run()` again: each run reads the source from the start (a
  function source is called again; a generator is used up after one run)
  and runs every step from scratch.

## 2. Batches

sluice reads the source `batch_size` records at a time, and each batch goes
through every step, down to the sink, before the next batch is read. With
`batch_size=500` and 1,200 records, a run has three batches: 500, 500,
and 200.

Batches keep memory flat on big exports. They're invisible to `map` and
`filter`, which look at one record at a time. They matter in two places:

- **Aggregates work per batch** unless you tell them otherwise (section 4).
- **Sinks write each batch as it arrives** (section 5), so if a run fails,
  the batches before it are already written (section 6).

`report.batches` says how many batches a run had.

## 3. Records and steps: `map` and `filter`

```python
def to_dollars(order):
    return {**order, "amount": order["amount"] / 100}

pipeline.map(to_dollars)                       # one record in, one record out
pipeline.filter(lambda order: order["amount"])  # keeps the records where it's truthy
```

- `.map(fn, name=None, on_error="fail")`: `fn(record)` returns the new
  record, a dict. To drop records, use `filter`: a map that returns anything
  but a dict is an error.
- `.filter(fn, name=None, on_error="fail")`: keeps the records for which
  `fn(record)` is truthy.
- A step's name defaults to the function's name (`"map"` or `"filter"` for a
  lambda). The run report and errors use it, so name steps you'll want to
  find.

**Records are read-only.** Steps get each record as a `sluice.Record`, which
reads like a dict but can't be changed: `record["amount"] = 5`,
`del record["x"]`, and `record.update(...)` raise `TypeError`. Return a new
dict instead: `{**record, "amount": 5}`, or `record.replace(amount=5)`, which
does the same. `dict(record)` gives you a plain copy.

A `TypeError` from changing a record is an error in that step like any other,
so the step's `on_error` (section 6) decides what happens to the record.

## 4. Aggregating

```python
pipeline.aggregate(by="store", total=sluice.Sum("amount"), orders=sluice.Count())
# {"store": "north", "total": 42, "orders": 3}, one record per store
```

`.aggregate(by, scope="batch", name="aggregate", on_error="fail", **fields)`
groups records by the `by` field (or a tuple of fields), and puts out one
record per group: the `by` fields, plus one field per keyword. The keywords
are your output fields, so they can't be called `by`, `scope`, `name`, or
`on_error`.

| | |
|---|---|
| `sluice.Sum(field)` | The total of `field`. |
| `sluice.Count()` | How many records. |
| `sluice.Min(field)`, `sluice.Max(field)` | The smallest or largest `field`. |

**`scope` says what an aggregate sees:**

- **`scope="batch"` (the default): each batch is aggregated on its own.** A
  group with records in three batches comes out as three records, each with
  that batch's part of the total.
- **`scope="run"`: the whole run is aggregated.** The aggregate holds its
  groups until the source is used up, then puts out one record per group,
  which go on through the steps after it. Nothing reaches those steps before
  the end of the run.

Use `"batch"` when the groups can't span batches, or when the steps after it
can add up the parts. When you need one total per group for the whole run,
use `"run"`.

```python
records = [{"store": "north", "amount": n} for n in (10, 20, 30)]
by_batch = sluice.Pipeline(records, batch_size=2).aggregate(by="store", total=sluice.Sum("amount")).run()
print(by_batch.output)   # [{'store': 'north', 'total': 30}, {'store': 'north', 'total': 30}]
by_run = sluice.Pipeline(records, batch_size=2).aggregate(by="store", total=sluice.Sum("amount"), scope="run").run()
print(by_run.output)     # [{'store': 'north', 'total': 60}]
```

## 5. Sinks and tables

```python
store = sluice.Store()
pipeline.sink(store.table("totals"), mode="upsert", key=("store", "day"))
```

A **Store** holds named tables in memory. `store.table(name)` gives you the
table, creating it the first time. Sinks write tables; you read them:

| | |
|---|---|
| `table.rows()` | Every row, as a list of dicts, in the order they were first written. |
| `table.find(**fields)` | The rows whose fields equal those values: `table.find(store="north")`. |
| `len(table)` | How many rows. |

`.sink(table, mode="append", key=None, name="sink")` writes every record that
reaches it as a row. A sink must be the last step, and a pipeline has at most
one. Without a sink, a run keeps the last step's records in `report.output`.

| `mode` | What a run writes |
|---|---|
| `"append"` (the default) | Adds every record as a new row. **Running the same pipeline twice writes every row twice.** |
| `"upsert"` | Needs `key`, a field or a tuple of fields. A record replaces the row with the same values in those fields, or is added if there isn't one. Running it again with the same records leaves the table as it was. |
| `"replace"` | Empties the **whole table** when the run starts, then adds every record. Rows from earlier runs are gone, including ones this run doesn't write again. |

A sink writes each batch as it arrives. A record that lacks a key field
can't be written, and fails the run: sinks have no `on_error`.

## 6. Errors

`map`, `filter`, and `aggregate` take `on_error`, which says what happens when
the step raises on a record:

| `on_error` | What happens |
|---|---|
| `"fail"` (the default) | **The run stops.** `run()` raises `sluice.RunFailed` (below). |
| `"skip"` | The record is dropped, and counted in the step's `skipped`. Nothing else about it is kept. |
| `"dead_letter"` | The record is dropped from the run, but kept in `report.dead_letters` with its error. |

A dead letter has three attributes: `step` (the step's name), `record` (the
record that step got, read-only), and `error` (the exception it raised).

```python
report = (sluice.Pipeline(rows)
          .map(parse, on_error="dead_letter")
          .sink(store.table("parsed"))
          .run())
for letter in report.dead_letters:
    print(letter.step, dict(letter.record), letter.error)
```

**What a failed run leaves behind.** Every batch that reached the sink before
the failure stays written. The batch that failed, and every batch after it,
write nothing. A `scope="run"` aggregate puts out nothing until the end of the
run, so a failed run writes nothing past it.

`RunFailed` has `step` (the name of the step that raised), `record` (the
record it raised on), `cause` (the exception), and `report` (the run report
up to the failure).

## 7. The run report

`run()` returns a `sluice.RunReport`:

| | |
|---|---|
| `report.read` | Records read from the source. |
| `report.batches` | Batches in the run. |
| `report.written` | Rows the sink wrote (added or replaced). |
| `report.steps` | A `StepReport` per step, in order: `name`, `kind`, `records_in`, `records_out`, `skipped`, `dead_lettered`. |
| `report.step(name)` | The `StepReport` for the step with that name. |
| `report.skipped` | Records skipped, across every step. |
| `report.dead_letters` | The dead letters, in the order they happened. |
| `report.output` | Without a sink, the last step's records, as dicts. |

`print(report)` shows it as a table:

```
big_orders: read 2 records in 1 batches, wrote 1 rows
  step           kind           in    out  skipped  dead letters
  filter         filter          2      1        0             0
  map            map             1      1        0             0
  sink           sink            1      1        0             0
```

A step's `records_out` is lower than its `records_in` when it filtered,
skipped, dead-lettered, or aggregated records. That's usually the fastest way
to see where records went.

## 8. Exceptions

| | |
|---|---|
| `sluice.RunFailed` | Raised by `run()` when a step raises under `on_error="fail"`, or a sink can't write a record. Has `step`, `record`, `cause`, and `report`. |
| `TypeError` | Raised inside a step when it changes a record (section 3), or when a map returns something that isn't a dict. |
| `ValueError` | Raised when you build a pipeline wrongly: an unknown `mode`, `scope`, or `on_error`, `upsert` without a `key`, or a step after the sink. |
