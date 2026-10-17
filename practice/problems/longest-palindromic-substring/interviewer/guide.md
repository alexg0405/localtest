# Interviewer guide: 5. Longest Palindromic Substring

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

**Brute force:** check every substring: O(n³).

**Good:** expand around each of the 2n − 1 centers (characters and gaps between
them) while the ends match. That's O(n²) time and O(1) extra space. A DP table
of "is s[i..j] a palindrome" is also O(n²) but uses O(n²) memory. Manacher's
algorithm is O(n), but interviewers rarely expect it.

**Pitfalls:** forgetting even-length palindromes (centers between characters);
off-by-one when slicing after the expansion loop.

Target: O(n²) time, O(1) space.

## Follow-up questions to ask

- Can you do it in O(1) extra space? (You just did, if you expanded around centers.)
- How would the DP version work, and what does it cost in memory?
- How would you count all palindromic substrings instead?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
