// @codex-health/rules-engine: pure, deterministic, no I/O, no clock, no network (CONSTRAINTS I9; SPEC §10).
export * from './types.ts';
export { parseExpression, referencedKeys, lintRule, usesIsUnknown, DslError } from './dsl.ts';
export type { Expr, RuleLike } from './dsl.ts';
export { and, or, not } from './kleene.ts';
export { evaluate, evaluateRule, runRuleTests, isRealDate, ENGINE_VERSION } from './evaluate.ts';
export type { Evaluation, EvaluateInput, Rule, RuleTestCase, RuleTestResult, Profile, TraceEntry, FinancialStatus } from './evaluate.ts';
