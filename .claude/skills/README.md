# Project skills

Two skills, vendored rather than subscribed: they are checked in, so a clone gets them and a
change to them is a reviewable diff. Both come from
[mattpocock/skills](https://github.com/mattpocock/skills) (MIT, © Matt Pocock), commit
`6654f6b`, whose own installer copies editable files in for exactly this reason.

| Skill                                                 | Fires when                                                                   | Local changes                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`domain-modeling`](./domain-modeling/SKILL.md)       | terminology is being argued about, `CONTEXT.md` is edited, an ADR is written | multi-context branch dropped; both format references rewritten to describe this repo |
| [`writing-for-agents`](./writing-for-agents/SKILL.md) | a skill, `AGENTS.md` or any agent-facing doc is written                      | verbatim                                                                             |

Two, not the other thirty-five upstream offers. The rest are workflow skills built on an issue
tracker this repo does not have, or cover ground the repo already holds — `AGENTS.md` for
conventions, `docs/manual-verification.md` for the checks jsdom cannot run, the `scripts/derive-*`
derivations for anything a claim rests on. A skill that duplicates one of those spends context to
say what is already said.

## Why these two

This repo's method is that decisions get written down where the next agent will find them: the
glossary in `CONTEXT.md`, the decisions in `docs/adr/`, the index in `AGENTS.md`, the reasoning in
the module headers. `domain-modeling` is the discipline that keeps the first two honest, and
`writing-for-agents` is how all four are written. Neither adds a workflow; they sharpen the one
already here.

## Updating

Upstream ships changes as a plugin; these are copies. To take a new version, diff the upstream
file against the local one and re-apply the local changes — the adaptations are listed in the
table above and repeated in a footer on each adapted file. Do not replace `CONTEXT-FORMAT.md` or
`ADR-FORMAT.md` wholesale: upstream's defaults (one-sentence glossary entries, single-paragraph
ADRs, no implementation detail) contradict this repo's, and taking them would quietly instruct the
next agent to flatten the documentation this repo runs on.
