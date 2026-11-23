# sitegen-lively — site-generator-speed-01

A faster drop-in reimplementation of makefun-site 1.0.0: byte-identical output trees, about twice as fast cold.

[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/jusst01/sitegen-lively/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/jusst01/sitegen-lively/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

Entry for [site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122) on make.fun.

## Layout

- `main.ts` — driver: reads `MAKEFUN_INPUT_DIR/cases.json`, calls `run(input)` per case, writes `MAKEFUN_OUTPUT_DIR/answers.json`
- `solve.js` — the optimized generator, exporting `run(input)`; Node builtins only

## Approach

Model-first: each site is parsed once into an internal model (front matter, Markdown, slugs, link resolution, posts/tags/recent), and every template is compiled into a generated JavaScript function — the template AST is emitted as a function body and instantiated with `new Function` — instead of being interpreted on every render. Compiled functions are cached per template, static subtrees are folded into string literals at compile time, shared partials are precomputed once, and element-pure loop bodies are memoized across pages.
