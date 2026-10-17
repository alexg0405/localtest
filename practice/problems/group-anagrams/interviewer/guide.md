# Interviewer guide: 49. Group Anagrams

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

**Approach:** give every word a canonical key that's the same for all its
anagrams, and group by key in a hash map.

- Sorted letters as the key: O(n · k log k) for n words of length k.
- A 26-letter count tuple as the key: O(n · k), better for long words.

**Pitfalls:** using a list as a dict key (lists aren't hashable, so use a tuple
or a string); comparing every pair of words, which is O(n² · k).

Target: O(n·k log k) time, O(n·k) space.

## Follow-up questions to ask

- How would you key the words without sorting?
- What if the words were very long but there were only a few of them?
- How would this change for Unicode text?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
