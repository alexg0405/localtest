**Feasibility:** it's impossible iff the most frequent character appears more
than ⌈n / 2⌉ = (n + 1) // 2 times.

**Greedy with a heap:** repeatedly take the most frequent remaining character
that isn't the one you just placed (pop two if needed). That's O(n log k) for k
distinct characters.

**Even–odd fill:** place characters, most frequent first, into indices 0, 2, 4,
… and then 1, 3, 5, …. That's O(n) after counting.

**Pitfalls:** the off-by-one in the feasibility check (n + 1) // 2; with the
heap, forgetting to push back the character you skipped.
