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
    const ok = spawnSync(process.execPath, [cli, 'rules', 'test', dir], { encoding: 'utf8', timeout: 30_000 });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/ 0 failure\(s\)\n$/);
    expect(ok.stdout).not.toMatch(/^LINT/m);
    const vent = rules.find((r) => r.id === 'seed.hard_stop.ventilator')!;
    const bad = { ...vent, tests: [...vent.tests!, { name: 'wrong', facts: { ventilator_use: 'yes' }, profile: { accepts_ventilator: false }, expected: 'false' }] };
    const tmp = `${tmpdir()}/zztest-rule-${process.pid}.json`;
    writeFileSync(tmp, JSON.stringify(bad));
    try {
      const fail = spawnSync(process.execPath, [cli, 'rules', 'test', tmp], { encoding: 'utf8', timeout: 30_000 });
      expect(fail.status).toBe(1);
      expect(fail.stdout).toMatch(/^FAIL  seed\.hard_stop\.ventilator :: wrong /m);
      expect(fail.stdout).not.toMatch(/^LINT/m);
    } finally {
      unlinkSync(tmp);
    }
  });
  it('the CLI evaluates a packet', async () => {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const factsFile = fileURLToPath(new URL('../../schemas/examples/facts/ventilator_use.json', import.meta.url));
    const profile = fileURLToPath(new URL('../../schemas/examples/profiles/zztest-facility.json', import.meta.url));
    const facts = `${tmpdir()}/zztest-facts-${process.pid}.json`;
    writeFileSync(facts, JSON.stringify([JSON.parse(readFileSync(factsFile, 'utf8'))]));
    try {
      const r = spawnSync(process.execPath, [cli, 'evaluate', facts, profile, dir, '--referral-date', '2001-01-04'], { encoding: 'utf8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.outcome).toBe('do_not_admit');
      expect(out.engine_version).toBe('0.1.0');
      const inc = spawnSync(process.execPath, [cli, 'evaluate', facts, profile, dir, '--referral-date', '2001-01-04', '--processing-incomplete'], { encoding: 'utf8', timeout: 30_000 });
      expect(JSON.parse(inc.stdout).resolution_step).toBe('processing_incomplete');
      for (const args of [['--referral-date', '2001-13-45'], ['--referral-date', '2001-01-04', '--processing-incomplete=true'], []]) {
        expect(spawnSync(process.execPath, [cli, 'evaluate', facts, profile, dir, ...args], { encoding: 'utf8', timeout: 30_000 }).status, args.join(' ')).toBe(2);
      }
      const badDir = `${tmpdir()}/zztest-rules-${process.pid}`;
      const { mkdirSync, rmSync } = await import('node:fs');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(`${badDir}/a.json`, '{}');
      writeFileSync(`${badDir}/b.json`, '{ not json');
      try {
        const bad = spawnSync(process.execPath, [cli, 'rules', 'test', badDir], { encoding: 'utf8', timeout: 30_000 });
        expect(bad.status).toBe(1);
        expect(bad.stderr.trim().split('\n')).toHaveLength(2); // every bad file reported, one line each
        expect(bad.stderr).not.toMatch(/^\s+at /m); // no stack frames
      } finally { rmSync(badDir, { recursive: true, force: true }); }
      const notArray = `${tmpdir()}/zztest-notarray-${process.pid}.json`;
      writeFileSync(notArray, '{}');
      try {
        const e = spawnSync(process.execPath, [cli, 'evaluate', notArray, profile, dir, '--referral-date', '2001-01-04'], { encoding: 'utf8', timeout: 30_000 });
        expect([e.status, e.stderr.trim().split('\n').length]).toEqual([1, 1]);
      } finally { unlinkSync(notArray); }
    } finally {
      unlinkSync(facts);
    }
  });
});
