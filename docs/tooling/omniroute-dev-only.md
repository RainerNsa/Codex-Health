# OmniRoute: developer machines only, never in the product path

OmniRoute 3.8.52 (diegosouzapw/OmniRoute, MIT) is a self-hosted AI gateway: one endpoint in front of
many providers, with free-tier pooling, fallback and prompt compression. A developer **may** run it on
their own machine as a gateway for their own coding agent (Claude Code or similar), to save cost and
avoid rate limits while working on code and synthetic data. That is the whole permitted use.

**Open question for the founders:** whether developers may use it at all has not been decided. Until
it is recorded in `../../ops/decision-log.md`, treat this page as the rules that would apply if the
answer is yes, not as permission.

## Why it is never in the product path

Production AI calls go to Claude on AWS Bedrock directly, under the AWS BAA, with a pinned model id.
OmniRoute cannot sit anywhere on that path because:

1. **No HIPAA or BAA.** Its documentation does not mention either; its `COMPLIANCE.md` covers only
   its own admin audit log.
2. **Free tiers route to third-party providers with no BAA.** A request can land anywhere.
3. **Full per-request logs** (`call_logs`, `proxy_logs`) are kept in local SQLite, 7-day default
   retention: a copy of every prompt and response on the developer's disk.
4. **Compression rewrites prompts** (RTK, Caveman). That breaks the verbatim-quote check and the
   record of which prompt version produced a result, both required by the audit trail.
5. **Its own audit writes are silently swallowed on failure.** Our audit standard does not allow that.

## Rules

- Never point any `@codex-health` package, service, env var or config at OmniRoute. The product's AI
  client has exactly one endpoint, Bedrock. `scripts/checks/bedrock-only.mjs` scans `apps/`, `services/`,
  `packages/`, `infra/`, `scripts/`, `docker-compose*.yml`, `Dockerfile*` and root `.env*` files and fails
  CI on any gateway reference: gateway and vendor hosts (`omniroute`, `litellm`, `openrouter`, Azure
  OpenAI, Mistral, Groq and the like, also when split across string literals), port `20128`,
  `/v1/chat/completions`, `/v1/messages` or `/v1/responses` on any host, `OMNIROUTE_*`, `OPENAI_*`,
  `ANTHROPIC_*`, `LITELLM_*` and `AI_GATEWAY_*` variables, `AWS_ENDPOINT_URL*` outside a LocalStack
  line, an `endpoint` option on `BedrockRuntimeClient`, non-literal `import()`/`require()`,
  base64-decoded URLs, and AI SDK dependencies (including `npm:` aliases). `@codex-health/shared`'s
  `bedrockClientConfig()` is the only way to build the client's configuration and refuses an endpoint
  override, a non-US region and an unpinned model id.
- Never paste synthetic golden packets, fixtures, or anything from a BAA-covered environment through
  it. It is for the agent's work on code, not for running the product's prompts.
- Coding-agent traffic only. No scripts, no tests, no CI job, no Docker Compose service in this
  repo may reference it.
- It runs on the developer's machine, bound to localhost, behind its own API key. Never expose it on
  a network, never point it at a shared instance.
- `.claude/settings.json` denies `curl` to its default port and to the vendor AI hosts, so an agent
  cannot be talked into calling it or them directly.

## Minimal setup sketch (developer machine, optional)

Follow the upstream README; the only project-specific points are below. Do not copy its
configuration into this repo.

1. Clone the upstream repo at tag `v3.8.52` outside this monorepo and run its `docker compose up`.
2. Before first start, copy its `.env.example` to `.env` and set the three required secrets
   (names per `docs/tooling/upstream/OmniRoute.env.example`): `JWT_SECRET` (`openssl rand -base64 48`),
   `API_KEY_SECRET` (`openssl rand -hex 32`), `INITIAL_PASSWORD` (replace `CHANGEME`). Keep `REQUIRE_API_KEY`
   on and the dashboard on localhost.
3. Keep its free-tier pooling off for Anthropic-model traffic if you want prompts to stay with one
   provider; turn compression off (it rewrites prompts, which also degrades code edits).
4. Point only your coding agent at it, in your shell profile, never in a file inside this repo.
5. Its SQLite logs hold every prompt for 7 days. Treat that directory as sensitive: it will contain
   repo code, and must never contain anything from a BAA environment.

Security notes from upstream are in `docs/tooling/upstream/OmniRoute.SECURITY.md`.
