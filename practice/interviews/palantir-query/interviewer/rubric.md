# Scoring rubric: Palantir FDSE learning interview on Weft

Score each area 1–5, or "not observed" when there is no evidence. This round
is about learning, not about knowing: finishing every part matters less than
how the candidate got to working queries.

| Area | 1 | 3 | 5 |
|---|---|---|---|
| Reading and understanding | Writes SQL before reading; guesses Weft's behavior. | Gets the main ideas from the docs, and explains most of what they use correctly. | Explains where Weft differs from SQL (missing, the join default, clause order, latest) as they use it, and checks the docs again when unsure. |
| Questions | None, or only ones the docs answer. | A few relevant questions. | Few, purposeful questions, including the real ambiguities (aircraft with no status, ties), with nothing the docs already answer. |
| Applying the language | Part 1 doesn't work. | Parts 1 and 2 work. | All parts work, using Weft as documented (is missing, count(*), join inner, latest, parameters). |
| Pace through the parts | Stuck on part 1. | Two parts working and tested in the 35 minutes. | All four parts, each tested before moving on (three is a solid 4). |
| Code quality | Hard to follow. | Clear. | One clause per line, every outside value a parameter, nothing done in Python that belongs in the query. |
| Communication and honesty | Silent, or bluffs. | Explains when asked. | Narrates the mental model, says "I'm not sure" when they aren't, and asks good questions. |
