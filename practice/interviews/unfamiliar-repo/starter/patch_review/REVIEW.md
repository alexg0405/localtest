# Review an AI-proposed patch

Another engineer on the rotation asked an AI coding assistant to "make the
nightly import stop failing". It produced `ai_patch.diff`, and with it applied the
nightly job exits 0 and `pytest` is green. They want to merge it before tonight's
run and have asked for your review.

Review it as you would a pull request:

1. What does the patch get right?
2. Would you approve it as is? If not, what is wrong, and how would you show it?
3. What would you change, and which tests would you add?

Read the diff, or try it: commit your own work first, then run
`git apply patch_review/ai_patch.diff`, run the job and the tests, and undo it with
`git apply -R patch_review/ai_patch.diff`. The patch is against the starter code, so if you
already changed the same lines, read it instead. You are not required to merge it.

Write your review in the dashboard's **Patch review** box (or in
`patch_review/my_review.md`; the dashboard reads that file when you submit).
