# Interviewer guide: Amazon SDE intern coding round

Spoilers: this file has the answers. Keep it out of the candidate's workspace.

## What this round simulates

A 45-minute Amazon technical interview that's only coding, the shape many SDE
intern candidates report for phone screens and coding-only loop rounds:
- One LeetCode-medium problem framed as a business task, in a plain shared editor. No AI.
- The interviewer wants the approach and its complexity before any code.
- A brute-force solution is fine to start, but the interviewer asks for its
  complexity and then "Can you do better?" until it's optimal or time runs low.
- The interviewer nudges a candidate who's stuck, with a hint as small as
  will get them moving.
- Once it works and it's fast, a follow-up extends it, and the last minutes
  are complexity, follow-up questions, and the candidate's questions.

## Coding problem

`days_until_cheaper(prices)`: for each day, how many days until a strictly lower
price, or 0 if there's none. This is "next smaller element".

Target: O(n) time and O(n) space, with a monotonic stack. Go through the days
once and keep a stack of the days still waiting for a lower price. Their prices
never go down toward the top. Today's price pops every waiting day with a
higher price, and each of those gets `today - day`. Then push today. Each day is
pushed once and popped at most once, so the whole pass is O(n) even though
there's a loop inside a loop. Walking backward with a stack of candidates works
too.

The brute force looks ahead from every day for the first lower price. It's
O(n²) in the worst case, which is prices that only rise (no day ever gets
cheaper, so every look-ahead runs to the end): about 5 billion comparisons for
100,000 days. Sorting doesn't help, because the order of the days matters.

Ambiguities to clarify (`clarifications.json`):
- the same price again doesn't count (strictly lower)
- never cheaper is 0, including the last day
- up to 100,000 days per item, millions of items
- an empty history returns []
- don't change the input list

Common mistakes:
- `>=` instead of `>` when popping, so equal prices resolve each other.
- Storing prices on the stack instead of days, then losing the day numbers.
- Calling the stack solution O(n²) because of the nested loop, or the brute force O(n).
- Answering the day count off by one.

## Pushing for the optimal solution

- If they propose the look-ahead first, ask its complexity. If they say O(n²),
  ask whether that's fine for 100,000 days per item and millions of items.
- If they can't find better within a couple of minutes, let them code the brute
  force, and come back to it once it works: "That works. Can we do better?"
- Good questions that don't give it away: "What work does the look-ahead
  repeat?", "Which days are still waiting when you get to today?", "What do
  the prices of the waiting days look like?"
- If they say the stack version is O(n²), ask how many times a day can be pushed and popped.

## Follow-up at minute 26 (or once it's fast and the tests pass)

`PriceWatch.add(price)`: the same stack, kept between calls. Each add pops the
waiting days with a higher price, reports `(day, today - day)` for each, oldest
first (they pop newest first, so reverse), and pushes today. O(1) amortized per
add, O(n) worst case for a single call (one low price after a long rise), and
O(n) memory for the waiting days.

A strong candidate sees that their batch stack is already the streaming
solution. A candidate who did the brute force usually scans every waiting day
on each add, which is O(n) per call. Ask what one add costs.

## Follow-up questions to ask

- What's the amortized cost of one add, and why? (each day is pushed once and popped at most once)
- What's the worst case for a single add, and does it matter for an alert service? (one low price can resolve every waiting day, so that one call is linear)
- How much memory can PriceWatch use, and what would you do about it? (prices that only rise keep every day waiting; cap it, or drop days older than the alert window)
- How would you run this for millions of items? (one watch per item, keyed by item ID, sharded by item)
- Which tests would you add? (the same price again, only rising, only falling, one big drop, empty)

## Signals

Green: clarifies "strictly lower" and input size; states the brute force and
its complexity, then finds the stack, or finds it after one "can you do
better?"; explains why the stack is O(n); dry-runs the example; reuses the stack
for the follow-up.
Red: codes without an approach; can't state complexity; calls the stack O(n²);
silent for long stretches; needs every hint.
