# ADR-0003: Synthetic-only development and test data

## Status
Accepted (dev-alignment 0.11; compliance review; COO brief). Supersedes the master plan's "synthetic or de-identified" wording.

## Date
2026-10-22

## Context
The master plan allowed "synthetic or de-identified" data in dev and test. The compliance review found that scanned referral packets cannot be reliably Safe-Harbor de-identified: dates, MRNs, provider names and free text survive redaction, and a single missed field makes the whole repository, every CI log and every developer laptop a PHI store with no BAA. The same question decides whether OmniRoute or any other coding-agent gateway is defensible on developer machines, since those gateways log requests and route to third-party providers. QA still needs at least 20 real de-identified packets before the M5 gate, because synthetic packets alone cannot prove the extraction numbers mean anything on real EHR print-outs.

## Decision
1. All data on developer machines, in CI, in dev and test environments, in fixtures, golden packets and the demo organisation is **synthetic**. Fake names are obviously fake (`ZZTEST, Patient`); synthetic MRNs, dates of birth and provider names follow the same convention.
2. Every synthetic packet carries the canary name and MRN from `scripts/checks/canary-strings.json`; `canary-phi.mjs` fails any build in which a canary string reaches a log, snapshot, bundle or test artefact.
3. Real packets, including de-identified ones (the P1 replay set, QA's ≥ 20 packets, hospital-platform exports), are handled **only in the BAA-covered evaluation environment** under a data agreement, never on a developer machine, in CI, in a fixture, or on any host a coding-agent gateway can reach. The evaluation harness exports per-field confusion matrices without PHI; packets never leave.
4. Nothing from either prototype's database is imported; the forensic runbook (dev-alignment 0.1) handles that data.
5. No real credential, key, account id or hostname in the repo or in fixtures; placeholders only.

## Alternatives considered

### "Properly de-identified" real packets as ordinary test data
Rejected (declined ask X9): de-identification of scans is unreliable, and one miss contaminates every downstream system.

### Real packets with synthetic overlays
Rejected: the overlay does not remove the original text layer or scan content.

### Synthetic only, with no real-packet evaluation at all
Rejected: the QA review shows synthetic-only gates pass and real packets fail. The BAA-covered evaluation path is the required M5 input; if it is not obtained the pilot-entry decision must say the gate was synthetic-only.

## Consequences
- Engineering builds a packet generator with real EHR layouts, fax cover sheets, rotation and scan degradation (M4) so synthetic packets look like real ones.
- The BAA-covered evaluation environment is a separate Terraform workspace with its own access list; developers' coding agents have no credentials to it.
- Invariant I8 and the data policy in CONSTRAINTS.md §5 follow from this decision.
