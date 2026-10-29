// The example rule records under packages/schemas pass rule CI: they parse, declare their inputs, and every
// case they carry evaluates as expected. The CLI runs the same thing.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { lintRule, runRuleTests, type Rule } from '../src/index.ts';

const dir = fileURLToPath(new URL('../../schemas/examples/rules/', import.meta.url));
const rules = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(dir + f, 'utf8')) as Rule);

describe('example rules', () => {
  it('lint clean and every own test case passes', () => {
    expect(rules.length).toBeGreaterThanOrEqual(4);
    expect(rules.flatMap((r) => lintRule(r))).toEqual([]);
    const results = runRuleTests(rules);
    expect(results.length).toBeGreaterThanOrEqual(12);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });
  it('the CLI runs rule tests and exits 0, and exits 1 on a failing case', () => {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const ok = spawnSync(process.execPath, [cli, 'rules', 'test', dir], { encoding: 'utf8' });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/0 failure\(s\)/);
    const bad = { ...rules[0]!, tests: [{ name: 'wrong', facts: {}, profile: {}, expected: 'true' }] };
    const tmp = `${tmpdir()}/zztest-rule-${process.pid}.json`;
    writeFileSync(tmp, JSON.stringify(bad));
    const fail = spawnSync(process.execPath, [cli, 'rules', 'test', tmp], { encoding: 'utf8' });
    unlinkSync(tmp);
    expect(fail.status).toBe(1);
  });
  it('the CLI evaluates a packet', () => {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const factsFile = fileURLToPath(new URL('../../schemas/examples/facts/ventilator_use.json', import.meta.url));
    const profile = fileURLToPath(new URL('../../schemas/examples/profiles/zztest-facility.json', import.meta.url));
    const facts = `${tmpdir()}/zztest-facts-${process.pid}.json`;
    writeFileSync(facts, JSON.stringify([JSON.parse(readFileSync(factsFile, 'utf8'))]));
    const r = spawnSync(process.execPath, [cli, 'evaluate', facts, profile, dir, '--referral-date', '2001-01-04'], { encoding: 'utf8' });
    unlinkSync(facts);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.outcome).toBe('do_not_admit');
    expect(out.engine_version).toBe('0.1.0');
  });
});
