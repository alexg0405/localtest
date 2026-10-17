**Key idea:** "can she finish at speed k" is monotonic: if speed k works,
every faster speed works too. So binary search on the *answer*, between 1 and
`max(piles)`.

Each check costs O(n): `sum(ceil(p / k))`. Total: O(n log max(piles)) time,
O(1) space. Trying speeds one by one is O(n · max(piles)), far too slow when
piles hold a billion bananas.

**Pitfalls:** using float division for the ceiling; an off-by-one in the binary
search loop; searching from 0 (division by zero).
