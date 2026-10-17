from __future__ import annotations

from collections import deque
from typing import List


def find_order(num_courses: int, prerequisites: List[List[int]]) -> List[int]:
    """Kahn's algorithm: repeatedly take a course with no remaining prerequisites. O(V + E)."""
    after: List[List[int]] = [[] for _ in range(num_courses)]
    needs = [0] * num_courses
    for course, before in prerequisites:
        after[before].append(course)
        needs[course] += 1
    ready = deque(course for course in range(num_courses) if needs[course] == 0)
    order: List[int] = []
    while ready:
        course = ready.popleft()
        order.append(course)
        for nxt in after[course]:
            needs[nxt] -= 1
            if needs[nxt] == 0:
                ready.append(nxt)
    return order if len(order) == num_courses else []
