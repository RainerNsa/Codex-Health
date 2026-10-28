# ADR-0001: Rules decide, AI extracts, humans finalize

## Status
Accepted (master plan, both team plans, all eight sector reviews; COO brief 2026-10-21)

## Date
2026-10-22

## Context
Codex Health answers "can this facility safely, appropriately and financially accept this patient?" from referral packets of dozens to hundreds of pages (brief §2, §3). Prototype B let the AI return the verdict; Prototype A matched keywords. Neither recommendation could be traced to a criterion or a page, and a pilot disagreement could not be split into "the extraction was wrong" and "the rule was wrong". The brief's never-acceptable outcomes are a false Admit, Unknown treated as No, one facility seeing another's data, and a failed run that still shows a confident answer. Referral text is untrusted input: a packet can lie, carry invisible OCR text, or carry prompt-injection strings. Rule content also encodes payer, psychiatric and social inputs that Section 1557, PASRR and ADA constrain, so every decision needs a defensible, versioned basis.

## Decision
Three separate responsibilities, enforced in code and schema, never only in the UI:

1. **AI extracts.** A pinned Claude model on Bedrock returns schema-bound, three-valued facts (Yes/No/Unknown), each with a document, page and verbatim quote. The model has no tools, never sees the rules and never outputs an outcome. A quote that fails verbatim verification makes the fact Unknown.
2. **Rules decide.** A pure, deterministic rules library (no network, no clock) evaluates facility-specific rules written as reviewed JSON data under Kleene three-valued logic, in a fixed resolution order (SPEC.md §4). Unknown never becomes Admit or No. Rule changes are versioned, approved by the business founder, and re-run only the engine.
3. **Humans finalize.** A Reviewer or Admin confirms every fact feeding a triggered rule or hard-stop input against the rendered page image, then finalizes. Overrides need a reason; a hard stop → Admit override needs a second, different Admin, enforced in the database. Every evaluation pins criteria, rule-set, profile, model, prompt and extractor versions and is written to an append-only, hash-chained audit log.

The AI-written narrative summary is out of the MVP; the "why" is rendered from the rule trace.

## Alternatives considered

### AI returns the verdict (Prototype B)
Fastest to demo. Rejected: untraceable, unauditable, vulnerable to a lying packet, and it makes pilot disagreements unattributable.

### Rules only, with manual data entry
Deterministic and cheap. Kept as the first slice (M2 manual fact-entry screen) and as the fallback when extraction fails, but alone it does not remove the reading burden the product exists to remove.

### AI extracts and also ranks or scores the outcome
Rejected: a score is an outcome by another name, cannot be traced to a criterion, and reintroduces automation bias.

## Consequences
- The engine can be built and tested before any extraction exists (rules engine first; property tests for "no Admit on Unknown or failure").
- Every disagreement in the pilot splits cleanly into extraction error, rule error, or human judgment.
- Needs Review will be common until criteria and confirmation UX are tuned; the risk is an unused product, not an unsafe one. Mitigations are scheduled (minimum confirmation set, ranked Needs Review, usability sessions).
- Invariants I1, I2, I5, I6 and I9 in CONSTRAINTS.md follow from this decision and may not be weakened by any agent.
