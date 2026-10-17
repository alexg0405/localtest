from __future__ import annotations

from collections import deque
from typing import List


def num_islands(grid: List[List[str]]) -> int:
    """Flood-fill each unvisited land cell with BFS (iterative, so big islands can't hit the recursion limit). O(R*C)."""
    rows, cols = len(grid), len(grid[0]) if grid else 0
    seen = [[False] * cols for _ in range(rows)]
    count = 0
    for r in range(rows):
        for c in range(cols):
            if grid[r][c] != "1" or seen[r][c]:
                continue
            count += 1
            seen[r][c] = True
            queue = deque([(r, c)])
            while queue:
                x, y = queue.popleft()
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < rows and 0 <= ny < cols and grid[nx][ny] == "1" and not seen[nx][ny]:
                        seen[nx][ny] = True
                        queue.append((nx, ny))
    return count
