# Interviewer guide: 3. Longest Substring Without Repeating Characters

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

**Brute force:** for each start, extend until a repeat: O(n·k) for windows of
length k, up to O(n²).

**Optimal:** a sliding window. Move `i` forward; when `s[i]` was last seen at
or after `start`, jump `start` to one past that position. Track each
character's last index in a dict. That's O(n) time, O(min(n, alphabet)) space.

**Pitfalls:** moving `start` backwards on an old repeat ("abba"); resetting
the whole window instead of jumping just past the repeat ("dvdf").

Target: O(n) time, O(alphabet) space.

## Follow-up questions to ask

- What if you could allow each character to appear at most twice?
- What changes if the alphabet is just 26 lowercase letters?
- How would you return the substring itself, not just its length?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
