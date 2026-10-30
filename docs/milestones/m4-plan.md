# M4 plan — the thin end-to-end slice

Goal: a synthetic referral packet goes in, source-linked facts and a recommendation come out, on the five slice
facts. Investor target (F5). Each slice is a PR with security and test reviews.

| Slice | Delivers | Needs AWS? |
| --- | --- | --- |
| 1. Pipeline core | Worker logic behind OCR and extractor interfaces: quote verification, AI facts, raw evaluation, T2/T3, all written in one transaction | No (fakes) |
| 2. Real adapters | Textract and Bedrock clients (pinned model, temperature 0, prompt caching, schema-bound output, no tools), SQS send and receive, worker service, demo wiring | To run, yes; CI never calls them |
| 3. Evidence on screen | AI facts in the review view with their quote and page; preliminary (unverified) label; confirm a fact; signed document view | No |
| 4. Re-process loop | Document-level partial results, addenda, what-changed diff between runs (4.1) | No |
| 5. Packet generator and eval harness | Synthetic packets with real layouts and degradation; eval on the five slice facts (4.5) | Eval runs need it |
| 6. Exit checks | Fault injection, measured cost per packet and cache reads, egress and logging checks, the demo organisation (4.3, 4.4, 4.6, 4.7) | Yes |

Not M4: fuzzy quote matching and page-coordinate highlights (M5). Usability session 2 (4.8) waits on F6.

## To settle in slice 2 (security review of PR #35)

- **Who says which facility a job belongs to.** The worker must not trust the queue message, but under row-level
  security it cannot read the referral before binding a facility. Options: a narrow owner-run lookup by referral id,
  or a message signed by the API.
- **The exit from a job that keeps failing.** Bad entries are dropped, but an extractor outage or missing settings
  still leaves a referral in processing; the dead-letter path must move it to partial failure.
- **Preliminary recommendations.** A review-rule fact the extractor is silent on can still give a raw Admit (§4 step 3
  covers hard-stop and critical inputs only); a person must state it at T12. The raw result is shown labelled
  preliminary (slice 3); changing the resolution order would need a founder decision.
