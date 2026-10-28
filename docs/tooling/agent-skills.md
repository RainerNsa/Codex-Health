# Agent tooling: agent-skills and ponytail

How the two coding-agent packs are installed in this repo, how to install them properly, and which
skill to use at which milestone. Versions in use are recorded in `docs/tooling/upstream/VERSIONS.txt`.
OmniRoute (the third tool in the assessment) has its own page: `omniroute-dev-only.md`.

## What is installed today (2026-10-22)

Both packs are installed as Claude Code **plugins at project scope**: `.claude/settings.json` lists them
under `enabledPlugins` and their sources under `extraKnownMarketplaces`, so anyone who opens this repo in
Claude Code is offered the same two plugins. Nothing from either pack is copied into the repo; the
licences, manifests and the ponytail compact ruleset (reproduced at the top of `AGENTS.md`) are kept in
`docs/tooling/upstream/` for the record.

| Plugin | Version | Provides | Notes |
|---|---|---|---|
| `agent-skills@addy-agent-skills` (addyosmani/agent-skills) | 0.6.13 | 25 skills (`agent-skills:<name>`), the 4 personas (`code-reviewer`, `security-auditor`, `test-engineer`, `web-performance-auditor`), the 9 commands (`/spec`, `/constraints`, `/plan`, `/build`, `/test`, `/review`, `/ship`, `/code-simplify`, `/webperf`) | Session-start hook is the plugin's own |
| `ponytail@ponytail` (DietrichGebert/ponytail) | 5.3.2 | `/ponytail`, `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-help`, the session-start auto-activation hooks and the status band | Default level `full` (see below). Plugin hooks and the band only become active in a **new** Claude Code session |

First-time setup on another machine: open the repo in Claude Code and accept the two plugins when
prompted, or run the two installs by hand (two separate prompts each):

```
/plugin marketplace add addyosmani/agent-skills
/plugin install agent-skills@addy-agent-skills
/plugin marketplace add DietrichGebert/ponytail
/plugin install ponytail@ponytail
```

Ponytail's plugin has four `userConfig` options (task-board ledger, webhook URL, webhook token, send
names). Leave the webhook empty: nothing about this repo's sessions leaves the machine. Task names in the
sidebar may contain ticket text, so `sendNames` stays off if a webhook is ever configured.

## Setting ponytail to `full`

`full` is ponytail's default, and the level this project runs at (never `ultra`; it questions
requests, and here the requests are founder decisions already recorded). To pin it anyway:

```bash
export PONYTAIL_DEFAULT_MODE=full        # highest priority
```

or in `~/.config/ponytail/config.json` (Windows: `%APPDATA%\ponytail\config.json`):

```json
{ "defaultMode": "full" }
```

Level changes inside a session (`/ponytail lite|ultra`) last until the session ends.

## Updating the plugins

1. `/plugin marketplace update` then `/plugin update <plugin>` (or `claude plugin update` from a shell);
   read the upstream changelog first.
2. If ponytail's `AGENTS.md` changed upstream, refresh `docs/tooling/upstream/ponytail.AGENTS.md` and
   the top half of our `AGENTS.md` (the "Project overrides" section is ours and stays).
3. Record the new version, date and plugin commit in `docs/tooling/upstream/VERSIONS.txt`.
4. Run `npm run check` and `npm test`; review the diff with `/ponytail-review`.

Project rules never live inside a plugin: they are in `CLAUDE.md`, `AGENTS.md`, `.claude/rules/` and
`CONSTRAINTS.md`, which wins any conflict.

## Which skill at which milestone

| Milestone | Skills and commands | Notes |
|---|---|---|
| M0 spec, constraints, foundations | `/spec` (`spec-driven-development`), `/constraints` (`constraint-driven-development`), `interview-me` | `interview-me` for every founder decision; record in `../ops/decision-log.md` and `docs/adr/`. |
| M1–M2 data model, RLS, audit, rules engine | `doubt-driven-development`, `test-driven-development`, `/plan`, `/build` (never `/build auto` here), `/test` | Doubt-driven is required on the outcome resolver, Kleene logic, RLS policies, audit hash chain, override handling. Rule CI never calls Bedrock or Textract. |
| M3+ API, pipeline, UI | `frontend-ui-engineering`, `api-and-interface-design`, plus the M1–M2 set on any PHI path | `observability-and-instrumentation` as each service lands; `browser-testing-with-devtools` for the reviewer UI. |
| Every PR | `/review` (`code-review-and-quality`), `security-and-hardening`, `/ponytail-review` | `security-auditor` and `test-engineer` personas on any change touching PHI paths, `packages/db`, `packages/rules-engine` or audit code. `/code-simplify` when a diff grew. |
| Before each pilot gate | `/ponytail-debt` | Every `shortcut:` is paid off or accepted on record. |
| M6 purge drill, M7 prod, M8 pilot | `shipping-and-launch` (`/ship`), `ci-cd-and-automation`, `deprecation-and-migration` for any schema change | Pre-launch checklist, rollback plan, staged rollout. |
| Any time | `context-engineering` (new session, drifting output), `debugging-and-error-recovery`, `documentation-and-adrs`, `git-workflow-and-versioning` | |

The meta-skill `using-agent-skills` holds the full decision tree.
