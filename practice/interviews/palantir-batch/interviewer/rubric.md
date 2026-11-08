# Scoring rubric: Palantir FDSE learning interview (batch processor)

Score each area 1–5, or "not observed" when there is no evidence. This round
is about learning and debugging, not about knowing: finishing every part
matters less than how the candidate got to working code.

| Area | 1 | 3 | 5 |
|---|---|---|---|
| Reading and understanding | Codes before reading; guesses sluice's behavior. | Gets the main ideas from the docs, and explains most of what they use correctly. | Explains sluice's ideas and the job's flow correctly as they use them (batches, scope, sink modes, error policies), and goes back to the docs when a symptom doesn't fit. |
| Questions | None, or only ones the docs answer. | A few relevant questions. | Few, purposeful questions, including the real ambiguities (bad readings in meter_gaps, billing an account with a bad reading), with nothing the docs already answer. |
| Applying the library | Part 1 doesn't work. | Parts 1 and 2 work. | All parts work, using sluice as documented (scope="run", upsert with the right key, dead letters), with each bug reproduced before it's fixed. |
| Pace through the parts | Stuck on part 1. | Two parts working and tested in the 35 minutes. | All four parts, each tested before moving on (three is a solid 4). |
| Code quality | Hard to follow. | Clear. | Small pipelines with named steps, new dicts instead of changed records, no workarounds outside the job. |
| Communication and honesty | Silent, or bluffs. | Explains when asked. | States the symptom, a guess at the cause, and how they'll check it; says "I'm not sure" when they aren't. |
