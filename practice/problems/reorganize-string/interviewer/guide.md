# Interviewer guide: 767. Reorganize String

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

**Feasibility:** it's impossible iff the most frequent character appears more
than ⌈n / 2⌉ = (n + 1) // 2 times.

**Greedy with a heap:** repeatedly take the most frequent remaining character
that isn't the one you just placed (pop two if needed). That's O(n log k) for k
distinct characters.

**Even–odd fill:** place characters, most frequent first, into indices 0, 2, 4,
… and then 1, 3, 5, …. That's O(n) after counting.

**Pitfalls:** the off-by-one in the feasibility check (n + 1) // 2; with the
heap, forgetting to push back the character you skipped.

Target: O(n) or O(n log k) time, O(k) space.

## Follow-up questions to ask

- What if equal characters had to be at least k positions apart?
- Why does filling the even indices first with the most common letter always work?
- What's the complexity of the heap version in terms of distinct characters?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
