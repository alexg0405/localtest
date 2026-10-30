# Palantir FDSE learning interview (practice)

This simulates the Learning round of a Palantir Forward Deployed Software
Engineer onsite: 30 minutes with an engineer from a commercial deployment.
You'll work with a library you've never seen, from its docs, and extend a
customer's tool with it, one part at a time.

## How this round works

| Minutes | What happens |
|---|---|
| 0–5 | Read the relay docs (the **Docs** tab) and the sync tool (the editor), and ask questions. You won't take it all in: get the main ideas, and come back to the docs as you build. When you're ready, press **Ready for the task** or say so. |
| 5–30 | Extend the sync, one part at a time. Each part shows up in the **Tasks** tab with an example test. When the tests pass, the next part comes. Press **Next part** to move on without finishing. Say what you understand about relay as you use it. |
| If time's left | What surprised you, what you'd change, and your questions for the interviewer. |

- **What's judged:** reading before you code, saying your understanding out
  loud (so the interviewer can correct it early), a few purposeful questions,
  small steps you test, and honesty when you aren't sure. Bluffing is the
  fastest way to fail this round. Not finishing every part is normal: in 25
  minutes, two parts is a solid pace.
- **No AI.** Write and run your code in the browser editor. **Run tests**
  runs the tests for the parts you've seen, and **Custom input** runs any
  Python against your code. Grading runs more tests after you submit.

## The customer

A regional network of six hospitals. Every night, our team's sync tool pulls
each hospital's supply inventory and builds a report of the items below their
par level, so the supply team can reorder before the 6am shift. Tonight it
pulls one hospital after another and takes 40 minutes, and the hospitals'
systems are old and unreliable.

## The code

- `supplysync/sync.py`: pulls every hospital and builds the report. **You'll
  change this file.**
- `supplysync/client.py`: the hospitals' inventory API, `fetch_page`, and its
  errors. Simulated here, with the same paging, latency, and failures as the
  real systems.
- `supplysync/report.py`: the report, and `Pull`, what the sync returns.
- `supplysync/sample.py`: a sample night's data, for trying things out.
- `relay/`: our team's job library. Its docs are `relay/DOCS.md`, in the Docs
  tab. Don't change it: other deployments use it too.

Ask the interviewer about anything that isn't specified.
