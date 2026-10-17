# Interviewer guide: 875. Koko Eating Bananas

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

**Key idea:** "can she finish at speed k" is monotonic: if speed k works,
every faster speed works too. So binary search on the *answer*, between 1 and
`max(piles)`.

Each check costs O(n): `sum(ceil(p / k))`. Total: O(n log max(piles)) time,
O(1) space. Trying speeds one by one is O(n · max(piles)), far too slow when
piles hold a billion bananas.

**Pitfalls:** using float division for the ceiling; an off-by-one in the binary
search loop; searching from 0 (division by zero).

Target: O(n log max(piles)) time, O(1) space.

## Follow-up questions to ask

- Why is the search range 1 to max(piles), and could you tighten the lower bound?
- Where else have you seen 'binary search on the answer'?
- What's the complexity if the number of hours were tiny compared with the piles?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
