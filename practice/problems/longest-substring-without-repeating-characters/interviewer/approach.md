**Brute force:** for each start, extend until a repeat: O(n·k) for windows of
length k, up to O(n²).

**Optimal:** a sliding window. Move `i` forward; when `s[i]` was last seen at
or after `start`, jump `start` to one past that position. Track each
character's last index in a dict. That's O(n) time, O(min(n, alphabet)) space.

**Pitfalls:** moving `start` backwards on an old repeat ("abba"); resetting
the whole window instead of jumping just past the repeat ("dvdf").
