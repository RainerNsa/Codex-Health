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

## Settled in slice 2

- **Who says which facility a job belongs to.** No new privilege. The message's facility is only a claim: the worker
  looks the referral up bound to that facility, row-level security hides it under any other, and a pair that finds
  nothing is refused and dead-letters (XF-13). A forged but true pair can only start work already due. The database's own
  check ties each document key to its facility and referral.
- **The exit from a job that keeps failing.** The worker reads the dead-letter queue too: it marks the waiting documents
  failed and moves the referral to partial failure, evaluated when the settings allow it. A dead letter stands down if a
  document arrived after its job was sent, and only the worker's role can touch that queue.
- **A document against a person.** The person's value stands, the key is listed in `disagreements` on every evaluation,
  and Admit is refused until a person states that key again.
- **The model.** The pinned-id rule (`bedrockClientConfig`, dated ids only) and temperature 0 fit `InvokeModel` with
  `bedrock-2023-05-31`. Newer models with undated ids, or that refuse temperature, need a founder decision first.

## Still to do

- **Slice 6:** a referral stays in processing if the queue send fails after the commit (503 to the user); the watchdog
  re-sends (`enqueue.failed` is logged, with ids only). Measure cache reads: the system prompt may sit under the model's minimum cacheable size.
- **Slice 3, before any demo with AI facts:** evidence on screen. Until then a raw recommendation is labelled preliminary
  on the review screen only, not in the queue.
- **Slice 4:** a document that failed on a passing Textract fault cannot be re-sent, because the same file is refused as a
  duplicate; a person can only mark it not applicable. Retry OCR without repeating it on every delivery, and decide a
  referral-level page cap, which needs a page count before OCR (documents over 300 pages fail after OCR, before the model).
- **Slice 6:** a depth alarm on the dead-letter queue. The demo's API and worker share one user and one role, accepted for
  synthetic data only.
- **First real run:** nothing here has called Textract or Bedrock. Confirm the model accepts `output_config`, Textract
  can read the KMS-encrypted bucket with the server's role, and a long packet finishes inside the 15-minute visibility.
- **Preliminary recommendations.** A review-rule fact the extractor is silent on can still give a raw Admit (§4 step 3
  covers hard-stop and critical inputs only); a person must state it at T12. The raw result is shown labelled
  preliminary (slice 3); changing the resolution order would need a founder decision.

## Accepted limit until M5 (re-review of PR #35)

A quote proves its words are on the page, not that they are about this fact: `ventilator_use = no` backed by "No recent
aggression" verifies. A person states every hard-stop and review fact before an Admit (T12), so this cannot finalize
anything. M5 adds key-aware checks and the page-image confirmation that reads `single_source`. Slice 3 shows
`disagreements` on screen (§13 row 4).
