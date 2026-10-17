# Interviewer guide: 1. Two Sum

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

**Brute force:** check every pair: O(n²) time, O(1) space.

**Optimal:** one pass with a hash map. For each value, look up its complement
`target - value` among the values seen so far; if it's there, you're done.
Otherwise remember the value's index. That's O(n) time and O(n) space.

**Pitfalls:** storing before checking lets an element pair with itself; with
duplicates, a dict built up front overwrites the earlier index.

Target: O(n) time, O(n) space.

## Follow-up questions to ask

- What if the list were already sorted? Could you do it with O(1) extra space?
- What if you had to return every pair that adds up to the target?
- When would you prefer sorting over the hash map?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
