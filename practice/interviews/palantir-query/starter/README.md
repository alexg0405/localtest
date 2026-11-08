# Palantir FDSE learning interview: the query language (practice)

This simulates the Learning round of a Palantir Forward Deployed Software
Engineer onsite: 45 minutes with an engineer from a commercial deployment.
You'll learn a query language you've never seen, from its docs, and use it to
answer a customer's questions about their data, one part at a time. Weft and
the customer are made up for this practice round.

## How this round works

| Minutes | What happens |
|---|---|
| 0–10 | Read the Weft docs (the **Docs** tab) and the customer's code (the editor), and ask questions. You won't take it all in: get the main ideas, and come back to the docs as you build. When you're ready, press **Ready for the task** or say so. |
| 10–45 | Answer the customer's questions with Weft, one part at a time. Each part shows up in the **Tasks** tab with an example test. When the tests pass, the next part comes. Press **Next part** to move on without finishing. Say what you understand about Weft as you use it. |
| If time's left | What surprised you, what you'd change, and your questions for the interviewer. |

- **What's judged:** reading before you code, saying your understanding out
  loud (so the interviewer can correct it early), a few purposeful questions,
  small steps you test, and honesty when you aren't sure. Bluffing is the
  fastest way to fail this round. Not finishing every part is normal: in 35
  minutes, three parts is a solid pace.
- **No AI.** Write and run your code in the browser editor. **Run tests**
  runs the tests for the parts you've seen, and **Custom input** runs any
  Python against your code. Grading runs more tests after you submit.

## The customer

Tallwood Air, a regional airline with eleven aircraft at two bases, Portland
(PDX) and Boise (BOI). Our team built their operations dashboard: planners,
dispatchers, and the maintenance control center all look at it through the
day. Every panel on it is a Weft query that runs in their warehouse, against
three tables: the fleet, every flight, and the defect log. They keep asking
for new panels.

## The code

- `fleetops/queries.py`: the dashboard's queries. Each function returns a
  Weft query and its parameters. **You'll add to this file.**
- `fleetops/report.py`: `run`, which runs a query and returns its rows, and
  `show`, which prints them as a table.
- `fleetops/sample.py`: three days of the warehouse's tables, with notes on
  what's in each, for trying things out.
- `weft/`: our team's query language. Its docs are `weft/DOCS.md`, in the
  Docs tab. Don't change it: other deployments use it too.

To try a query, put this in **Custom input**:

```python
from fleetops import queries, report
report.show(report.run(queries.fleet_at("PDX")))
```

Ask the interviewer about anything that isn't specified.
