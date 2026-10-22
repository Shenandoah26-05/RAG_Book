# Reports

Markdown reports of experiment runs that a decision cites. A report is made by
`pnpm report <experiment> --out docs/reports/<name>.md` after `pnpm experiment <file>` has finished.

- `evals/results/` holds every run and is **not** committed; it is the working folder.
- A report is committed here only when an ADR in `docs/adr/` cites it. It is self-contained: it
  includes the full config of every variant and the config hashes, so it still says what was compared
  after the run folder is gone.
- Name a report after the experiment and the dataset version: `retrievers-v1.md`.
- Never edit a report that an accepted ADR cites. Run the experiment again and add a new report.

Decisions cite reports; reports cite configs.
