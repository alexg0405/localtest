**Approach:** give every word a canonical key that's the same for all its
anagrams, and group by key in a hash map.

- Sorted letters as the key: O(n · k log k) for n words of length k.
- A 26-letter count tuple as the key: O(n · k), better for long words.

**Pitfalls:** using a list as a dict key (lists aren't hashable, so use a tuple
or a string); comparing every pair of words, which is O(n² · k).
