from __future__ import annotations

from collections import deque
from typing import List


def oranges_rotting(grid: List[List[int]]) -> int:
    """Multi-source BFS from every rotten orange at once, one layer per minute: O(R*C)."""
    rows, cols = len(grid), len(grid[0]) if grid else 0
    queue = deque((r, c) for r in range(rows) for c in range(cols) if grid[r][c] == 2)
    fresh = sum(row.count(1) for row in grid)
    state = [row[:] for row in grid]
    minutes = 0
    while queue and fresh:
        for _ in range(len(queue)):
            r, c = queue.popleft()
            for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                if 0 <= nr < rows and 0 <= nc < cols and state[nr][nc] == 1:
                    state[nr][nc] = 2
                    fresh -= 1
                    queue.append((nr, nc))
        minutes += 1
    return minutes if fresh == 0 else -1
