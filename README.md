# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

An entry for the [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty
"Build mend, one patch tool for every AI edit format".

`mend` is a command-line tool that applies AI-written edits in four formats
(unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches and
JSON tool calls) to a tree of text files, to the written specification in
`SPEC.md`. It finds the lines an edit names at the first of three matching
tiers (exact, trailing whitespace ignored, surrounding whitespace ignored),
re-indents at the loosest tier, and changes every file or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file; absent or `-` reads standard input.
- `--format=NAME` reads one format (`unified`, `search-replace`, `v4a`,
  `json`); `auto`, the default, detects it.
- `--check` does everything but write.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path plus `ok: <n> files`; exit 1 lists
each failed edit and `failed: <k> of <n> edits` (nothing is written);
exit 2 is a usage, missing-patch, format or parse error.

## How it works

`main.ts` (Node 22, standard library only) implements the whole of `SPEC.md`:
the command line, safe paths, format detection, three-tier line matching,
unified diffs (sections, hunks, renames, creations, deletions, moves, the
`\ No newline at end of file` rule), SEARCH/REPLACE blocks, V4A patches
(anchors, cursor, end-of-file chunks, moves) and JSON edits, applied in
patch order with all-or-nothing writes.

## Local checks

```
node check.ts ../program/generator/practice.json   # from the kit's starter
```

The 100 public practice checks pass (practice score 1000), plus 10 extra
hand-written checks for sentences the practice set does not show
(`hand-tests.json`, kept out of the submitted commit).

## License

MIT. See `LICENSE`.
