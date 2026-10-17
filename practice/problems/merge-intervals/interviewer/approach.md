**Approach:** sort by start (O(n log n)), then sweep once. Keep the last
merged interval; if the next one starts at or before its end, extend the end to
the max of both ends, otherwise start a new merged interval. That's O(n log n)
time and O(n) for the output.

**Pitfalls:** using `<` instead of `<=` for touching intervals; overwriting the
end with the new end instead of the max (fails on nested intervals);
forgetting the input isn't sorted.
