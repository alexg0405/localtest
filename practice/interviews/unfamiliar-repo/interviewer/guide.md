# Interviewer guide: catalog-pipeline (unfamiliar repository)

Spoilers: this file has the root cause and the answers. Keep it out of the
candidate's workspace and out of the coding assistant's reach.

## What this exercise checks

Diagnosing a failure in code the candidate did not write, from a misleading
error message; making a focused fix instead of a rewrite; writing a regression
test that reproduces the failure; and spotting a patch that hides the symptom.

## Root cause and planted defects

| Where | Defect | Visible test that catches it |
|---|---|---|
| `examples/supplier_feed.csv` + `stages.read_csv` | The supplier's new tool writes a UTF-8 byte-order mark. Opened as `utf-8`, the first header becomes `"\ufeffsku"`; `str.strip()` does not remove U+FEFF, so every row looks like it is missing `sku` and the run fails with "no valid rows". Fix: open with `utf-8-sig` (or strip a leading BOM from the first header). | `test_nightly_example_succeeds` |
| `stages.validate` | Reports `line {index}` (0-based data row) instead of `row.line`, so the error says "line 0" for the first data row; `parse_prices` uses `row.line` correctly. This misleads ops and the candidate. | none (grading only) |
| `stages.write_json` + `runner.run` | The runner refuses an empty catalog, but only after `write_json` has already overwritten the file with `[]`, so a bad feed still empties the storefront's catalog. | none (grading only) |
| `config.load_config` | Shallow merge `{**DEFAULTS, **user}`: a config that sets `options` loses every default option. Latent until the requirement change. | none (grading only) |

The error message ("missing sku" when the file obviously has a sku column) is the
puzzle. Strong candidates print `repr()` of the headers or the first bytes of the
file, or read the file in binary, and see the BOM.

## Timeline

- 0–5: questions. Important topics: what changed, the error output, scope,
  encoding and names, line numbers.
- 5–15: ask them to explain how a stage gets run (registry, config, runner)
  before they touch code, and to state a hypothesis.
- 15–40: reproduce, fix, test. Ask how they confirmed the cause before fixing.
- 30: reveal the semicolon requirement (`change_request.md`).
- 40–50: edge cases and the patch review.
- 50–60: incident-style explanation.

## Requirement change at minute 30

A semicolon delimiter set through `options.delimiter`, with the other options
defaulted. The obvious edit (read `options["delimiter"]`) appears to work for a
config that sets nothing, but the new supplier's config sets `options`, so the
shallow merge drops `dedupe_key` and `required` and the run crashes with a
`KeyError`. A good candidate writes a test with the exact config from the change
request and finds the merge bug; a deep merge must not mutate `DEFAULTS`.

## AI patch review

The patch decodes as `latin-1`, so the BOM becomes `ï»¿` and "Café" becomes
"CafÃ©"; a regex then strips non-letters from headers so matching works; and it
deletes the assertion on the product name from the visible test. The job exits
0 and tests pass, but the catalog is corrupted for every accented product, and
the configured encoding is ignored. A good review spots the deleted assertion,
shows the mojibake (run it and read the output), and proposes `utf-8-sig` plus a
test on output bytes.

## Follow-up questions to ask

- How would you have caught this before it paged someone? (A fixture from the
  supplier's real file, validation of the header row, alerting on row counts.)
- Why is "no valid rows" a failure instead of writing an empty catalog?
- Would you strip BOMs in every stage, or only when reading? Why?
- What else did you notice in the repository that you did not fix?

## Signals

Green: reproduces the failure first; forms and tests a hypothesis; small diff;
regression test from a BOM fixture; notices the line-number bug from the
error output. Red: rewrites the reader; changes the example file instead of the
code; accepts the AI patch because the job exits 0.
