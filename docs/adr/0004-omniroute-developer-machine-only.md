# ADR-0004: OmniRoute and any non-Bedrock AI gateway are developer-machine only

## Status
Accepted (master plan "Engineering toolkit"; tooling assessment 2026-10-21; compliance and security reviews)

## Date
2026-10-22

## Context
OmniRoute is a self-hosted AI gateway (one endpoint in front of many providers, free-tier pooling, automatic fallback, prompt compression). It is attractive for cutting the cost and rate limits of developers' coding agents. It is unsuitable for anything that touches a referral packet, for five verifiable reasons: its documentation mentions neither HIPAA nor a BAA; its free tiers route to third-party providers that have signed no BAA; it keeps full per-request logs (`call_logs`, `proxy_logs`) in local SQLite for seven days by default; its compression engines rewrite prompts, which breaks the verbatim quote check and the record of which prompt version produced a result; and its own audit writes are silently swallowed on failure, which §13 does not allow. The same objections apply to any other gateway, proxy or direct provider API placed in front of the product.

## Decision
1. **The product path calls Claude on Amazon Bedrock directly, with a pinned model id, under the AWS BAA.** No gateway, proxy, router, cache or direct third-party API sits between the pipeline and Bedrock. `bedrock-only.mjs` fails CI on any other endpoint, SDK or environment variable in `apps/`, `services/` or `packages/`.
2. **OmniRoute (and similar) may run only on developers' own machines, only for coding agents, only over code and synthetic data.** It has no credentials to dev, test, evaluation or production environments and no network path to them.
3. Any host that can reach OmniRoute or another gateway is by definition outside the BAA-covered evaluation environment and may never hold a real packet (ADR 0003).
4. Configuration for a developer-side gateway lives outside this repository (the only traces are `docs/tooling/upstream/OmniRoute.env.example` as reference material and the developer note `docs/tooling/omniroute-dev-only.md`); product code never reads it.
5. A short note in the security policy records this boundary for the M8 security questionnaire pack.

## Alternatives considered

### OmniRoute in the pipeline as a Bedrock front with fallback disabled
Rejected: logging, compression and swallowed audit writes remain, and a configuration change would re-enable third-party routing silently.

### Ban developer-side gateways entirely
Considered. Not required: developers already work only on synthetic data, so the boundary costs nothing, and the cost and rate-limit relief is real. Revisit if a developer machine ever needs access to the evaluation environment.

## Consequences
- Developer convenience is preserved; production has exactly one AI endpoint to audit.
- Any future need for a second model provider is a superseding ADR and a new BAA, not a gateway setting.
- Floor rule and invariants I7 and I8 in CONSTRAINTS.md follow from this decision.
