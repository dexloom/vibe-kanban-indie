<!--
SpecKit project constitution.
Edit this to capture the non-negotiable principles every feature must honor.
The Specify / Plan / Analyze stages read this file and check work against it.
-->

# Project Constitution

## Core Principles

### I. Clarity over cleverness
Code and specs are written to be read. Prefer the obvious solution; justify any
non-obvious one in the spec.

### II. Test the contract
Every feature defines how we will know it works (acceptance criteria) before it
is implemented. No feature is "done" without a checkable validation.

### III. Small, reversible steps
Ship the smallest change that delivers value. Avoid speculative generality.

## Constraints
- Follow the existing architecture and conventions of the repository.
- Do not introduce new top-level dependencies without recording the reason in
  the plan's research notes.

## Governance
This constitution supersedes ad-hoc preferences. When a spec or plan conflicts
with it, the constitution wins or the conflict is recorded as an open question.

**Version**: 0.1.0
