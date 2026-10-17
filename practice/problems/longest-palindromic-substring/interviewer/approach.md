**Brute force:** check every substring: O(n³).

**Good:** expand around each of the 2n − 1 centers (characters and gaps between
them) while the ends match. That's O(n²) time and O(1) extra space. A DP table
of "is s[i..j] a palindrome" is also O(n²) but uses O(n²) memory. Manacher's
algorithm is O(n), but interviewers rarely expect it.

**Pitfalls:** forgetting even-length palindromes (centers between characters);
off-by-one when slicing after the expansion loop.
