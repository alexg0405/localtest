# Review an AI-proposed patch

While you were exploring, a teammate asked an AI coding assistant to fix the
double-charge report. It produced `ai_patch.diff`, says the visible tests pass,
and the teammate wants your review before merging.

Review it as you would a pull request:

1. What does the patch get right?
2. Would you approve it as is? If not, what is wrong, and what input or sequence
   of calls shows the problem?
3. What would you change, and which test would you add to prove it?

Read the diff, or try it: commit your own work first, then run
`git apply patch_review/ai_patch.diff`, run the tests, and undo it with
`git apply -R patch_review/ai_patch.diff`. The patch is against the starter code, so if you
already changed the same lines, read it instead. You are not required to merge it.

Write your review in the dashboard's **Patch review** box (or in
`patch_review/my_review.md`; the dashboard reads that file when you submit).
