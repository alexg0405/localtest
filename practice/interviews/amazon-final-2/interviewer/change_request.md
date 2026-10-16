# Follow-up from the interviewer

The warehouse now has a forklift that can move shelves out of the robot's way.

Change the signature to `min_moves(grid, clears=0)`:

- The robot may pass through up to `clears` shelf (`#`) cells. Each shelf it
  passes through uses one clear.
- Return the fewest moves to reach a pick station, or -1 if it still can't.
- With `clears=0` it behaves exactly as before.

```python
min_moves(["D#P"])            # -1
min_moves(["D#P"], clears=1)  # 2
```

Talk me through how your search changes before you code it.
