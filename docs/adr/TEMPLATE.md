# ADR-VSC-NNNN: Title in sentence case

**Date:** YYYY-MM-DD
**Status:** Accepted

## Context

What forced a decision. The situation as it was, the constraint that made the status quo
untenable, and the alternatives that were genuinely on the table. Written so that someone who
has never seen this repository can follow it.

## Decision

What was decided, stated flatly and in the present tense. One paragraph where possible.

## Rationale

Why this and not the alternatives. One bullet per reason. Name the alternative and say what it
costs — an ADR that only argues for its own choice is a press release.

## Consequences

What is now true that was not before, **including the costs**. What a contributor must now do,
what CI now enforces, what becomes harder. Do not list only the benefits.

---

*Notes for the author, delete before committing:*

- Insert **at most one** domain-specific section between `## Decision` and `## Consequences`
  when the decision has internal structure worth naming.
- An ADR is never edited once accepted. Correct it by appending
  `## Amendment (YYYY-MM-DD): one-line summary`, or supersede it and set this one's status to
  `Superseded by ADR-VSC-NNNN`.
- When citing a decision from the sibling compiler repository, **name the repository**:
  `jpipe-compiler ADR-0022`, never a bare `ADR-0022`.
