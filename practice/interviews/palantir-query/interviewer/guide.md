# Interviewer guide: Palantir FDSE learning interview on Weft

Spoilers: this file has the answers. Keep it out of the candidate's workspace.

## What this round simulates

The Learning round of a Palantir Forward Deployed Software Engineer onsite,
in its most reported form: use an internal SQL-like language to query a
customer's data. In 45 minutes: up to ten to read the language's
documentation, then about 35 to answer the customer's questions with it in a
few short stages. It tests how fast someone gets from unfamiliar to
productive. Interviewers watch for:
- reading the docs before writing queries, and treating them as the map
- saying where Weft differs from SQL out loud, so it can be corrected early
- a few purposeful questions, not a stream of low-level ones, and none they
  could answer by reading
- building each query a clause at a time and running it
- honesty: "I'm not sure, let me check" beats a confident wrong answer

The language, Weft, is made up, so nobody can know it in advance. It looks
like SQL on purpose: the round rewards the candidate who reads the docs over
the one who writes SQL from memory.

## The material

The customer is Tallwood Air, a regional airline with eleven aircraft at PDX
and BOI. fleetops/queries.py holds the dashboard's queries, each returning
`(text, params)`. Three tables: `aircraft` (two have no status yet),
`flights` (cancelled flights have no times or delay; Coastline Connect's
partner aircraft fly some, and aren't in `aircraft`), and `defects` (an
append-only log, out of time order). Weft's ideas the candidate has to learn
from DOCS.md:
- **Clause order.** `from` first, then latest, join, where, group by,
  compute, sort, limit, and `select` last. Out of order is an error.
- **`==` and double quotes.** `=` and single quotes are errors.
- **`missing`.** Every comparison with missing is false, `!=` included; use
  `is missing`. (`not (a == b)` does include missing.)
- **Grouping.** `count(*)` counts rows, `count(x)` and `avg` skip missing.
  After `group by`, only keys and computed columns are left.
- **Joins.** A plain `join` keeps unmatched rows (a left join); `join inner`
  drops them. A clashing column comes back as `table.column`.
- **`latest per k by c`.** Keeps each key's largest-c row, and runs before
  `where`.
- **Parameters.** `$name`, bound through params; values only. Missing values
  sort last, even descending.

## Questions to check understanding

Reading time is only ten minutes, so mostly let them read. Ask one of these
when they explain what they've read, or as they start to use the part it
covers, one at a time. Don't give the answer: if they're wrong, ask them to
look at the section again.
- Where does `select` go in a Weft query? (Last. A query starts with from.)
- If an aircraft's status is missing, is `status != "grounded"` true or false for it? (False: every comparison with missing is false.)
- A group has three flights, one cancelled with a missing delay. What do `count(*)`, `count(delay)`, and `avg(delay)` give? (3, 2, and the average of the two that flew.)
- After `group by tail`, can you sort by `origin`? (No: only the group keys and computed columns are left.)
- You join flights to aircraft, and a flight's tail isn't in aircraft. What happens to it? (It stays, with the aircraft's columns missing, unless you write join inner.)
- Both defects and aircraft have a `status`. After the join, what's each called? (status is the defect's; aircraft.status is the aircraft's.)
- Does `latest` run before or after `where`? (Before: it comes right after from.)
- Why pass the airport in params rather than in the query text? (A value can't change what the query does, and quotes in it can't break it.)

## The parts

**Part 1, unavailable aircraft.** `where status != "in service" or status is
missing`, `sort tail`, `select tail, model, base, status`. The trap is
`!=` alone, which drops the two aircraft with no status; the example test
shows them. Ask whether they asked about aircraft with no status, or noticed
it from the test. Also `not (status == "in service")` works: ask them why.
Traps: `!=` alone; `== missing` (an error that points to section 3);
`select` first (an error).

**Part 2, delays.** `where origin == $airport group by tail compute flights =
count(*), avg_delay = round(avg(delay), 1), worst = max(delay) sort
avg_delay desc, tail limit $top`, with airport and top in params. Rounding in
`select` after the sort works too. The ties ambiguity: ask whether they asked.
Traps: `count(delay)` (drops cancelled flights); pasting the airport into the
query with an f-string; selecting a non-key column after `group by`;
expecting missing averages first under `desc`.

**Part 3, hours.** `join inner aircraft on tail`, `where date >= $since and
arrived is not missing`, `group by model compute flights = count(*), hours =
round(sum(hours_between(departed, arrived)), 1)`, `sort hours desc`.
`count(arrived)` instead of the `is not missing` filter works too. The trap
is the plain `join`: Coastline Connect's flights stay, with a missing model,
and become a fourth group. Traps: plain join; counting cancelled flights.

**Part 4, defect briefing (stretch).** `from defects latest per defect by
at`, `join aircraft on tail`, `where status in ("open", "deferred") and
aircraft.status == "in service" and base == $base`, `sort at`, `select
defect, tail, model, system, status, updated = at`. Traps: filtering on
status before deduping (Weft makes it an order error: let them read why);
`status == "in service"` (that's the defect's status: no rows); leaving out
the latest clause, so a closed defect's old open row shows up.

## Follow-up questions to ask

Only if the parts end with time to spare. When the 45 minutes are up, stop.

- What surprised you about Weft, compared with the SQL you know? (missing and !=, the left-join default, select last, latest before where)
- Where did the docs leave you unsure, and how did you resolve it?
- Which Weft default would you change if you owned it, and what would that break for the other deployments?
- If the defect log grew to millions of rows, what would you want from Weft or the warehouse? (an index on the key, filtering in the warehouse)
- How would you check that the dashboard's numbers match what the maintenance team sees in their own system?

## Signals

Green: reads sections 2, 3, and 5 before writing a query; explains missing
and the join default back correctly; asks about the real ambiguities (aircraft
with no status, ties); builds a query a clause at a time and runs it; says
"I'm not sure" and checks the docs.
Red: starts writing SQL in the first minute or two; guesses at Weft's
behavior from SQL; misses the partner group in part 3 and doesn't look at
the rows; asks questions the docs answer in their first lines; claims
understanding that the query contradicts.
