[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/prima1999/site-generator-speed-01-run-20261122-entry-1/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/prima1999/site-generator-speed-01-run-20261122-entry-1/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122-entry-1

A fast, dependency-free reimplementation of makefun-site 1.0.0's build, written
for the [make.fun bounty "Build a static site faster, 22 November 2026"](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`main.ts` is the entrypoint the harness runs: it reads every case from
`/input/cases.json`, answers each one with `run` from `solve.js`, and writes
`/output/answers.json`. `solve.js` returns, for one case's input, exactly the
output tree makefun-site 1.0.0's build returns: each page's `index.html`, the
index and tag pages, `build-report.txt` and each static file, byte for byte.

The speed comes from single-pass work with no throwaway objects: bodies are
scanned in place rather than split into line arrays, blocks render straight
into one shared output array, templates render into that same array, and slugs
are memoised. The build reads no clock, no environment and no randomness, and
its output is deterministic.

## Layout

- `main.ts` — the driver (reads cases, writes answers).
- `solve.js` — the solver; `run(input)` returns the output tree.
- `LICENSE` — MIT.

## Verify locally

With the kit unpacked at `<kit>`:

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
MAKEFUN_OUTPUT_DIR=/tmp/out MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
  MAKEFUN_SCORES_DIR=/tmp/scores node <kit>/program/scorer/main.ts
```

The scorer should report `passed: 1` with `cases_passed: 3` of `3`.
