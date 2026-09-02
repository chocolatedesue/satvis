---
name: domain-modeling
description: Build and sharpen this project's domain model. Use when discussing codebase terminology, writing or editing CONTEXT.md, or recording or editing an ADR.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the _active_ discipline: challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise. (Merely _reading_ `CONTEXT.md` for vocabulary is not this skill: that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

## Where it lives

One context, one glossary:

```
/
├── CONTEXT.md          ← the domain glossary
├── docs/adr/           ← the decisions and the alternatives they beat
│   ├── 0001-url-parameter-specification.md
│   └── …
└── src/
```

`AGENTS.md` is the index that points at both. Keep it pointing: a new doc nobody can find is load with no reach.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y. Which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account': do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible. Which is right?"

This repo makes that check cheap on purpose: the `src/modules/util/` modules are Cesium-free and directly testable, and the derivation scripts under `scripts/` re-measure the claims the glossary quotes. A term whose entry cites a number should cite one a script still prints.

### Update CONTEXT.md inline

When a term is resolved, update `CONTEXT.md` right there. Don't batch these up: capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

---

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), `skills/engineering/domain-modeling`, commit `6654f6b`. The multi-context `CONTEXT-MAP.md` branch is dropped — this repo is one context — and the two format references describe what this repo actually does rather than the upstream defaults. See `.claude/skills/README.md`.
