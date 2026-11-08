# Palantir FDSE learning interview (practice): the nightly billing job

This simulates the Learning round of a Palantir Forward Deployed Software
Engineer onsite: 45 minutes with an engineer from a commercial deployment.
You'll learn a batch processor you've never seen, from its docs, then use
it and debug a customer's job that's built on it, one part at a time.

## How this round works

| Minutes | What happens |
|---|---|
| 0–10 | Read the sluice docs (the **Docs** tab) and the billing job (the editor), and ask questions. You won't take it all in: get the main ideas, and come back to the docs as you work. When you're ready, press **Ready for the task** or say so. |
| 10–45 | Work on the job, one part at a time. Some parts add to it; others are bug reports from the customer to investigate, with a test that reproduces the symptom. Each part shows up in the **Tasks** tab with an example test. When the tests pass, the next part comes. Press **Next part** to move on without finishing. Say what you understand about sluice as you use it. |
| If time's left | What surprised you, what you'd change, and your questions for the interviewer. |

- **What's judged:** reading before you code, saying your understanding out
  loud (so the interviewer can correct it early), a few purposeful questions,
  reproducing a bug before you fix it, small steps you test, and honesty
  when you aren't sure. Bluffing is the fastest way to fail this round. Not
  finishing every part is normal: in 35 minutes, three parts is a solid
  pace.
- **No AI.** Write and run your code in the browser editor. **Run tests**
  runs the tests for the parts you've seen, and **Custom input** runs any
  Python against your code. Grading runs more tests after you submit.

## The customer

A regional electric utility with about 400,000 smart meters. Every night,
our team's job takes the day's meter readings, one every 15 minutes from
every meter, adds up each account's usage, and prices it. The utility's
billing system bills from what the job writes, first thing in the morning,
so when the job is wrong, customers get wrong bills.

## The code

- `meterbill/job.py`: the nightly job, built on sluice. **You'll change
  this file.**
- `meterbill/billing.py`: what the billing system reads from the job's
  tables. It's the billing team's: read it, don't change it.
- `meterbill/sample.py`: a sample night's readings, for trying things out,
  and `meter_totals`, each account's usage added up straight from the
  readings.
- `sluice/`: our team's batch processor. Its docs are `sluice/DOCS.md`, in
  the Docs tab. Don't change it: other deployments use it too.

Ask the interviewer about anything that isn't specified.
