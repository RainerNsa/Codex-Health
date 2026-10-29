// CLI (SPEC §10.4). Reads JSON files, never the network, never a clock: the referral date is an argument.
//   evaluate <facts.json> <profile.json> <rules.json> --referral-date YYYY-MM-DD [--processing-incomplete] [--favorable-rule-required=false]
//   rules test <rule-set-dir-or-json>   (runs every rule's own cases and the static checks; exit 1 on any failure)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, runRuleTests, lintRule, isRealDate, type Rule } from './index.ts';

const usage = 'usage: evaluate <facts.json> <profile.json> <rules.json> --referral-date YYYY-MM-DD [--processing-incomplete] [--favorable-rule-required=false]\n       rules test <rule-set-dir-or-json>\n';
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const isRule = (r: unknown): r is Rule => !!r && typeof r === 'object' && typeof (r as Rule).id === 'string' && typeof (r as Rule).expression === 'string'
  && Array.isArray((r as Rule).inputs) && typeof (r as Rule).enabled === 'boolean' && ['hard_stop', 'review', 'favorable', 'payer'].includes((r as Rule).kind);
/** Every file is reported, one line each, before exiting; a bad file never hides the next one. */
const loadRules = (p: string): Rule[] => {
  const files = statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.json')).sort().map((f) => join(p, f)) : [p];
  const rules: Rule[] = [];
  const problems: string[] = [];
  for (const file of files) {
    let parsed: unknown;
    try { parsed = readJson(file); } catch (err) { problems.push(`${file}: ${(err as Error).message}`); continue; }
    for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!isRule(r)) { problems.push(`${file}: not a rule record (needs string id and expression, array inputs, boolean enabled, a known kind)`); continue; }
      rules.push(r);
    }
  }
  if (problems.length) { process.stderr.write(`${problems.join('\n')}\n`); process.exit(1); }
  return rules;
};

const KNOWN = new Set(['--referral-date', '--processing-incomplete', '--favorable-rule-required=false', '--favorable-rule-required=true']);
const fail = (msg: string): never => { process.stderr.write(`${msg}\n`); process.exit(1); };

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'evaluate' && rest.length >= 3) {
  const [factsPath, profilePath, rulesPath, ...opts] = rest as [string, string, string, ...string[]];
  const dateAt = opts.indexOf('--referral-date');
  const referral_date = dateAt >= 0 ? opts[dateAt + 1] : undefined;
  const unknown = opts.filter((o, i) => !KNOWN.has(o) && !(dateAt >= 0 && i === dateAt + 1));
  if (unknown.length) { process.stderr.write(`unknown option(s): ${unknown.join(' ')}\n${usage}`); process.exit(2); }
  if (!referral_date || !isRealDate(referral_date)) { process.stderr.write(usage); process.exit(2); }
  try {
    const facts = readJson(factsPath);
    if (!Array.isArray(facts)) fail('facts file must be a JSON array of facts');
    const profileFile = readJson(profilePath) as { capabilities?: Record<string, boolean | number> } & Record<string, boolean | number>;
    const rules = loadRules(rulesPath);
    const result = evaluate({
      facts: facts as never,
      profile: profileFile.capabilities ?? profileFile,
      rules,
      referral_date,
      processing_complete: !opts.includes('--processing-incomplete'),
      flags: { favorable_rule_required: !opts.includes('--favorable-rule-required=false') },
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  } catch (err) {
    fail(`evaluate failed: ${(err as Error).message}`);
  }
}
if (cmd === 'rules' && rest[0] === 'test' && rest[1]) {
  const rules = ((): Rule[] => { try { return loadRules(rest[1]!); } catch (err) { return fail(`rules test failed: ${(err as Error).message}`); } })();
  const problems = rules.flatMap((r) => lintRule(r));
  const results = runRuleTests(rules);
  for (const p of problems) process.stdout.write(`LINT  ${p}\n`);
  for (const r of results) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.rule_id} :: ${r.name} (expected ${r.expected}, got ${r.actual})\n`);
  const failed = problems.length + results.filter((r) => !r.ok).length;
  process.stdout.write(`${rules.length} rule(s), ${results.length} case(s), ${failed} failure(s)\n`);
  process.exit(failed ? 1 : 0);
}
process.stderr.write(usage);
process.exit(2);
