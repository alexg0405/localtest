# Interviewer guide: Amazon SDE intern final round 2

Spoilers: this file has the answers. Keep it out of the candidate's workspace.

## What this round simulates

The second of two back-to-back final rounds, a shape many Amazon SDE intern
candidates report for the Summer 2026 and Winter 2027 cycles:
- New Leadership Principles questions, since each round probes different ones.
- A state-search coding problem framed as a warehouse task.
- No AI, and a plain editor that doesn't run code.

## Leadership Principles

Two questions, three follow-ups each (`behavioral.json`):
- Have Backbone; Disagree and Commit / Earn Trust
- Learn and Be Curious / Dive Deep

Look for respectful, data-backed disagreement and real commitment afterwards.
For the mistake question, look for ownership of the mistake without deflecting,
a concrete root cause, and a mechanism that prevents a repeat.

## Coding problem

`min_moves(grid)`: breadth-first search from the dock. Every move costs 1, so
the first time BFS pops a `P` it is the shortest distance. That's O(R·C) time
and space. A strong candidate explains why DFS doesn't give the shortest path
and marks cells visited when they enqueue them, not when they dequeue them.

Ambiguities to clarify (`clarifications.json`):
- 4-directional moves only
- several stations (nearest wins)
- unreachable or no station (-1)
- no dock (ValueError)
- grid up to 500×500

Common mistakes:
- Recursive DFS: wrong answers, and recursion depth on big grids.
- Marking visited too late, which blows up the queue.
- Off-by-one move counts.
- Treating `P` or `D` as blocked.
- Forgetting several stations.

## Follow-up at minute 33

`min_moves(grid, clears=0)`: the robot may pass through up to `clears` shelves.
The fix is to make the BFS state `(row, col, clears_left)` and keep a visited
set per state. That's O(R·C·(k+1)). A visited set keyed only on `(row, col)`
gives wrong answers, because reaching a cell with more clears left can be
better.

## Follow-up questions to ask

- Why does BFS give the shortest path here, and when wouldn't it?
- What if moves had different costs, like turning taking longer?
- How would you handle a thousand robots asking for paths at the same time?

## Signals

Green: states BFS and its complexity before coding; dry-runs the example grid;
handles several stations without being told; extends the state cleanly.
Red: DFS with no reasoning; silent coding; can't explain visited handling;
stories where "we" did everything.
