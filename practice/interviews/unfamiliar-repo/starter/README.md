# catalog-pipeline

Imports a supplier's product CSV into the JSON file the storefront reads. It is
a small plugin-style pipeline: a JSON config lists stages, and each stage is a
function registered by name. See `docs/ARCHITECTURE.md`.

## The problem

You are on call. The nightly job (`scripts/nightly.sh`) has failed every night
since the supplier "upgraded their export tool". Nobody on the team wrote this
code, and the original author has left.

```sh
python -m pipeline examples/nightly.json
```

Run these with the practice virtualenv active: `source ~/interview-practice/.venv/bin/activate`
on macOS or Linux, or `& ~\interview-practice\.venv\Scripts\Activate.ps1` in PowerShell on
Windows (the dashboard shows the exact command for your setup).

Your job:

1. Diagnose why the nightly import fails, and explain the root cause.
2. Make a focused fix. Do not rewrite the pipeline.
3. Add regression tests so this cannot silently come back.
4. Review a patch an AI assistant proposed for the same failure
   (`patch_review/REVIEW.md`).

Your interviewer plays the on-call lead. Ask them anything that is unclear.

## Expected behaviour

- Each run reads `input`, normalizes headers (case and surrounding spaces do not
  matter), skips invalid rows, converts `price` to integer cents, keeps the
  **last** row for each SKU, and writes items sorted by SKU to `output` as UTF-8
  JSON. Names must come through exactly as the supplier wrote them.
- Skipped rows are reported as `line N: ...`, where N is the row's line number
  in the CSV file (the header is line 1).
- The command exits 0 on success and 1 with an `error: ...` message on failure.

## Acceptance criteria

- `python -m pipeline examples/nightly.json` succeeds and writes the expected
  catalog.
- `pytest -q` passes, including your new regression tests.
- You can explain the root cause, your fix, and why it is safe for other
  supplier files.

## Also in this session

Partway through, the on-call lead may bring a new requirement. It will appear in
the dashboard and in `CHANGE_REQUEST.md` in this folder.
