# CONTEXT.md format

One file at the repo root, one flat list of terms under `# Domain glossary`, grouped under `##`
headings only where a natural cluster has formed. `AGENTS.md` points at it.

## An entry

```md
- **Repeat cycle**: how long a `repeating` pair takes to return to the same
  relative configuration — `p` orbits of one shell against `q` of the other.
  Every cross-shell range and every contact window repeats on it, so a schedule
  computed once holds forever, which is the whole point of designing a layout
  rather than picking one. The derivation measures 99.7% of satellites finding
  the same cross-shell partner one cycle later for the designed pair, against
  79.3% for a shell chosen for its coverage
  (`docs/adr/0009-multi-shell-layouts.md`).
```

Three parts, in this order: **what it is**, **why it is that and not the obvious alternative**, and
**where the rule lives** — the module that owns it, or the ADR that decided it.

## Rules

- **Be opinionated.** When several words exist for one concept, pick one and use it everywhere. The
  glossary is the tie-breaker, so it has to break the tie.
- **Say what it is, not what it does.** A definition that reads like a function summary belongs in
  the function.
- **Name the mechanism and the file.** Unlike a business-domain glossary, this one is read by
  someone about to change the code, so an entry that cannot be acted on has not finished. The
  reader should be able to open the owning module from the entry. What stays out is the
  _implementation_: the entry says a ring link's length holds to a part in a thousand, not how the
  polyline is built.
- **Quote the number the derivation printed.** Entries here carry measurements (a CV, a churn rate,
  a percentage). Cite what a script still prints, and re-run it when the entry changes. A number
  nobody can reproduce is worse than no number.
- **Only terms with a precise local meaning.** General programming concepts do not belong however
  heavily the project uses them. The test: would a competent engineer new to _this_ codebase guess
  wrong? Then it belongs.
- **Sharpen rather than append.** When a term drifts, edit its entry. A glossary that only ever
  grows is a changelog.

## Length

An entry runs as long as the distinction needs and no longer — several sentences is normal here,
because most of these terms are a decision with a reason attached, and the reason is the half that
stops the next person undoing it. If an entry is long because it is carrying two concepts, that is
two entries.

---

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), commit `6654f6b`.
Upstream asks for one or two sentences and no implementation detail; this repo's glossary is read
by an agent about to edit the module, so entries name the owning file and quote the measurement.
