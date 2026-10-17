**Brute force:** check every pair: O(n²) time, O(1) space.

**Optimal:** one pass with a hash map. For each value, look up its complement
`target - value` among the values seen so far; if it's there, you're done.
Otherwise remember the value's index. That's O(n) time and O(n) space.

**Pitfalls:** storing before checking lets an element pair with itself; with
duplicates, a dict built up front overwrites the earlier index.
