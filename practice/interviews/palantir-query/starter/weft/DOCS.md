# Weft

Weft is the query language our deployment teams use to answer questions over
a customer's tables. Queries run in the warehouse, next to the data, and come
back as rows. It looks like SQL on purpose, but **it isn't SQL**: if you know
SQL, read sections 2, 3, 5, and 8 closely, because that's where it differs.

It is an internal language shared by several deployments. Use it as it is.

## Contents

1. Running a query
2. Clauses and their order
3. Values, comparisons, and `missing`
4. Grouping: `group by` and `compute`
5. Joins
6. The latest row per key: `latest`
7. Parameters
8. Sorting, `limit`, and `select`
9. Functions
10. Errors

The examples use two tables: `orders` (`order_id`, `store`, `placed`,
`total`, `status`) and `stores` (`store`, `city`, `status`).

## 1. Running a query

```python
import weft

rows = weft.run('from orders where total > 100 select order_id, total', tables)
# [{"order_id": "A-7", "total": 140}, ...]
```

- `weft.run(query, tables, params=None)` runs a query and returns a **list of
  dicts**, one per row, with the columns in order.
- `tables` maps each table's name to a list of row dicts. A missing value is
  `None` in Python, both in the tables and in the result.
- `params` binds the query's parameters (section 7).
- Anything wrong with a query raises `weft.QueryError` (section 10). Weft
  never guesses what you meant.

A query can span lines. `#` starts a comment that runs to the end of the
line. Keywords ignore case (`FROM` is `from`); column and table names don't.

## 2. Clauses and their order

A query starts with `from <table>`, and its other clauses come **in this
order**, each at most once (only `join` can repeat):

| | |
|---|---|
| `from <table>` | The table to start from. Required, and always first. |
| `latest per <keys> by <column>` | Keeps one row per key (section 6). |
| `join [inner] <table> on <column>` | Adds another table's columns (section 5). |
| `where <condition>` | Keeps the rows where the condition is true. |
| `group by <columns>` | One row per group (section 4). |
| `compute <name> = <expression>, ...` | Aggregates, per group (section 4). |
| `sort <column> [desc], ...` | Orders the rows (section 8). |
| `limit <n>` | Keeps the first n rows (section 8). |
| `select <columns>` | Picks and names the columns (section 8). Always last. |

Clauses run one after another, in that order, each on the rows the one before
it produced. So `where` sees the columns a `join` added, and `sort` sees the
columns a `compute` made. `select` comes last, not first. A clause out of
order is an error, not a different query:

```
from orders sort placed where store == "S1"
# QueryError: `where` can't come after `sort` ... (line 1, column 25)
```

## 3. Values, comparisons, and `missing`

**Values.** Numbers (`42`, `9.5`), text in **double quotes** (`"open"`; single
quotes are an error), `true`, `false`, and `missing`. Times are ISO text
(`"2026-03-02T09:30"`), so comparing them as text puts them in time order.

**Comparisons.** `==`, `!=`, `<`, `<=`, `>`, `>=`. Equality is `==`: a single
`=` is an error in a condition, and only names a column in `compute` and
`select`. Combine conditions with `and`, `or`, and `not`, and use parentheses
to group. `x in ("a", "b")` is true when x is one of the values. Comparing text
with a number is an error. Arithmetic: `+ - * /`.

**`missing`.** A missing value isn't equal to anything, not even another
missing value. **Every comparison with a missing value is false**, and that
includes `!=` and `not in`:

```
from stores where status != "closed"
# leaves out the stores whose status is missing: for them, != is false too
```

To find missing values, use `is missing` and `is not missing`:

```
from stores where status != "closed" or status is missing
```

`x == missing` is an error, because it could never be true. `not` turns false
into true, so `not (status == "closed")` does keep the missing ones. Arithmetic
with a missing value gives `missing`.

## 4. Grouping: `group by` and `compute`

```
from orders
group by store, status
compute orders = count(*), revenue = sum(total), biggest = max(total)
```

`group by` makes one row per distinct combination of its columns, and
`compute` adds a column per group. The aggregates:

| | |
|---|---|
| `count(*)` | The number of rows in the group. |
| `count(x)` | The number of rows where x is **not** missing. |
| `sum(x)`, `avg(x)` | The sum and the average of x, skipping missing values. |
| `min(x)`, `max(x)` | The smallest and largest x, skipping missing values. |

Aggregates skip missing values, so `avg(x)` averages only the rows that have
an x. When a group has no values at all, `sum`, `avg`, `min`, and `max` give
`missing` (and `count(x)` gives 0). An aggregate can sit inside a function:
`avg_total = round(avg(total), 2)`.

**After `group by`, the rows are the groups**: only the group keys and the
computed columns are left. Later clauses can't use any other column of the
original rows. Inside `compute`, a column that isn't a group key can only
appear inside an aggregate.

Rows whose key is missing form a group of their own, with the key missing.
Groups come out in no particular order: `sort` them if order matters.

`compute` without `group by` gives a single row for the whole table.
Aggregates only work in `compute`.

## 5. Joins

```
from orders
join stores on store
```

`join <table> on <column>` adds the other table's columns to each row whose
`<column>` matches. Both tables must have that column; it appears once in the
result. A row that matches several rows of the other table comes out once per
match. A missing value never matches anything.

**A join keeps every row, matched or not.** A row with no match in the other
table stays, with the other table's columns missing (in SQL terms, Weft's
`join` is a left join). To keep only the rows that match, write
**`join inner`**:

```
from orders
join inner stores on store     # orders from stores that aren't in `stores` are dropped
```

**Clashing names.** When the joined table has a column with the same name as
one the rows already have (other than the `on` column), the joined table's
column comes back **prefixed with its table's name**. Here both tables have a
`status`:

```
from orders
join stores on store
where status == "refunded" and stores.status == "open"
# status is the order's; stores.status is the store's
```

## 6. The latest row per key: `latest`

```
from orders
latest per order_id by placed
```

`latest per <keys> by <column>` keeps one row for each distinct key: the row
with the **largest** value of `<column>`. It's for logs where every change
adds a row, and you want each thing's current state. On a tie, the row further
down the table wins. A row whose `<column>` is missing loses to any row that
has a value.

`latest` comes right after `from` (section 2), so it runs **before** `where`:
`where` filters each key's latest row, not the whole log. The rows keep their
order in the table.

## 7. Parameters

```python
query = "from orders where store == $store and total > $least sort total desc limit $n"
weft.run(query, tables, params={"store": "S1", "least": 100, "n": 10})
```

`$name` stands for a value you pass in `params`. Use parameters for every
value that comes from outside the query (a user's choice, an argument), rather
than pasting text into the query: a value can never change what the query does.

- A parameter's value can be text, a number, `True` or `False`, or `None` (it
  is then `missing`).
- Parameters are **values only**. They can't stand for a column, a table, or a
  keyword: `sort $column` is an error.
- A parameter in the query with no value in `params` is an error. Extra
  entries in `params` are ignored.
- `limit` takes a parameter too.

## 8. Sorting, `limit`, and `select`

**`sort`** orders the rows by one or more columns, ascending unless you add
`desc`: `sort total desc, order_id` sorts by total, largest first, then by
order_id. **Missing values always sort last**, ascending or descending. Rows
that tie on every sort column keep their order.

**`limit n`** keeps the first n rows. It runs after `sort`, so `sort ... limit
n` is the top n.

**`select`** picks the columns of the result, in the order you list them, and
can name new ones: `select order_id, store, dollars = total / 100`. Without a
`select`, you get every column. Because `select` is last, `where`, `sort`, and
`limit` can't use the names it makes; `sort` uses the columns as they are
before `select`.

## 9. Functions

| | |
|---|---|
| `hours_between(start, end)` | Hours from one ISO time to another, as a number (`1.5` for 90 minutes). |
| `lower(text)` | The text in lowercase. |
| `round(x, digits)` | x rounded to that many decimal places (`digits` can be left out: 0). |

Every function gives `missing` when an argument is missing. Functions work in
any expression, and around aggregates in `compute`.

## 10. Errors

`weft.QueryError` covers everything: a syntax error, a clause out of order, a
column or table that doesn't exist, a parameter with no value, comparing text
with a number. Its message says what's wrong and where (`line 1, column 25`),
and it has `.line` and `.column`.

Weft checks columns as each clause runs, so a column that doesn't exist at
that point (after `group by`, say) is an error, with the columns that do.
