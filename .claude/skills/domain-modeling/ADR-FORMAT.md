# ADR format

`docs/adr/NNNN-slug.md`, sequential. Scan the directory for the highest number and increment.
Add the new one to the ADR list in `AGENTS.md` — an ADR nobody is pointed at is one nobody reads.

## Shape

```md
---
status: accepted
---

# {The question, answered — not the topic}

{Two or three paragraphs: what was being decided, and why the obvious answer was not it.}

## Decision

**{The claim, in bold, as a sentence.}** {Then the reasoning, and the numbers.}

**{The next claim.}** {…}

## Consequences

- {What this costs, what it rules out, and what a reader will trip over later.}
```

`status` is `accepted` unless the decision is still open (`proposed`) or has been overtaken
(`superseded by NNNN`). When a later ADR narrows an earlier one, edit the earlier one to say so
in a line and point forward: a rule that is quietly no longer true is worse than one that was
never written.

## Rules

- **Title the answer, not the subject.** "Multi-shell layouts: the second shell that holds, and
  the one that only looks like it does", not "Multi-shell layouts".
- **Lead each decision with a bolded claim.** A reader skimming the bold lines should get the
  whole decision; the prose underneath is the evidence.
- **Quote measurements, not adjectives.** The claims here are backed by what
  `scripts/derive-isl-topology.ts` prints. An ADR that says a topology is "stable" without a
  number has recorded a preference, not a decision.
- **Record what was rejected, and why it was tempting.** The rejected option is the one someone
  will propose again in six months.
- **Consequences are the costs.** Not a summary: the price, the limits, the thing that will
  surprise someone. "The globe is capped at imagery level 2" is a consequence; "this improves
  things" is not.

## When it earns an ADR

All three must be true:

1. **Hard to reverse** — changing your mind later costs something real.
2. **Surprising without context** — a future reader will look at the code and wonder why.
3. **A real trade-off** — there were genuine alternatives and one was picked for reasons.

If it is easy to reverse, you will just reverse it. If it is not surprising, nobody will wonder.
If there was no alternative, there is nothing to record beyond "we did the obvious thing."

What has qualified here: which inter-satellite links get drawn and which do not (0008), where a
second shell goes and why no two shells can be rigid (0009), why finding stable clusters is a
quotient rather than a clustering problem (0010). What did not: anything a test already pins.

---

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), commit `6654f6b`.
Upstream's default ADR is a single paragraph with optional sections; this repo's are longer and
carry `status` frontmatter, a `Decision` section of bolded claims and a `Consequences` section,
because the decisions here are backed by measurements a script can re-run.
