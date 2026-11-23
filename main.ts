// The entrypoint the harness runs: it reads every case from the input
// directory, answers each one with the local solver, and writes the answers
// to the output directory. The shape follows the house driver: V8's
// incremental marking is switched off before the solver is imported, so all
// of the solver's work runs under that setting.

import { setFlagsFromString } from 'node:v8';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Turn V8's incremental marking off before the solver is imported.
setFlagsFromString('--no-incremental-marking');

// The solver, imported by its URL: a plain .js module carries no types,
// so the import is typed by the contract it must satisfy.
const solver = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};
const run = solver.run;

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Every case in the input file, in order, with its id and input.
const loaded = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

// One answer per case, in the cases' order.
const results: unknown[] = [];
for (const entry of loaded) results.push(run(entry.input));

// The answers file holds the answers as one JSON array.
writeFileSync(join(outDir, 'answers.json'), JSON.stringify(results));
