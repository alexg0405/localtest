from __future__ import annotations


def longest_palindrome(s: str) -> str:
    """Expand around each of the 2n - 1 centers: O(n²) time, O(1) extra space."""
    best_start, best_length = 0, 1 if s else 0
    for center in range(2 * len(s) - 1):
        left, right = center // 2, center // 2 + center % 2
        while left >= 0 and right < len(s) and s[left] == s[right]:
            left -= 1
            right += 1
        length = right - left - 1
        if length > best_length:
            best_start, best_length = left + 1, length
    return s[best_start:best_start + best_length]
