// CONSTRAINTS: production AI calls go only to AWS Bedrock.
// Fails on any other AI client import, dependency, endpoint URL, gateway host or port, vendor env
// var, Bedrock client endpoint override, dynamic import or base64-hidden URL in product source,
// infra, scripts, docker-compose, Dockerfiles and root .env files.
// There is deliberately no comment marker that exempts a line.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, walk, scanFiles, formatHits, finish, SOURCE_EXTS } from './lib.mjs';

const NAME = 'bedrock-only';
const SCAN_DIRS = ['apps', 'services', 'packages', 'infra', 'scripts'];
const EXCLUDED = path.join(repoRoot, 'scripts', 'checks') + path.sep; // this checker's own patterns
const ROOT_FILE = /^(docker-compose.*\.ya?ml|Dockerfile.*|\.env.*)$/;
const EXTS = [...SOURCE_EXTS, '.json', '.yml', '.yaml', '.tf', '.tfvars', '.hcl', '.sh', '.toml', '.env', '.example'];

// Package names (exact, or scoped prefixes) that are AI clients, gateways or SDKs other than Bedrock.
const FORBIDDEN_PACKAGE =
  /^(openai|openai-edge|@anthropic-ai\/sdk|@google\/(generative-ai|genai)|openrouter|@ai-sdk\/.+|ai|langchain.*|@langchain\/.+|llamaindex|litellm|ollama|@mistralai\/.+|cohere-ai|groq-sdk|@azure\/openai|portkey-ai|together-ai|replicate|@huggingface\/inference)$/;
const PKG = FORBIDDEN_PACKAGE.source.slice(1, -1); // same alternation without the anchors
const DECODE = String.raw`(?:atob\s*\(|Buffer\.from\s*\([^)]*['"]base64['"])`;
const URLISH = String.raw`(?:https?:|aHR0cH)`; // "aHR0cH" is base64 for "http"

const PATTERNS = [
  { label: 'AI client import', re: new RegExp(`(from\\s+|require\\(\\s*|import\\(\\s*)['"](${PKG})(/[^'"]*)?['"]`) },
  { label: 'non-literal import/require', re: /\b(import|require)\s*\(\s*(?!(?:'[^'\n]*'|"[^"\n]*"|`[^`$]*`)\s*[,)])/ },
  { label: 'AI vendor host', re: /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/i },
  {
    label: 'AI gateway or vendor host',
    re: /\b(omniroute|litellm|openrouter|mistral\.ai|cohere\.ai|groq\.com|together\.xyz|openai\.azure\.com|inference\.ai\.azure\.com|huggingface|replicate|deepseek|x\.ai|perplexity)\b/i,
  },
  { label: 'OmniRoute port', re: /:20128\b/ },
  // Local AI gateways: Ollama (11434), LM Studio (1234), LiteLLM (4000).
  { label: 'localhost AI gateway', re: /(localhost|127\.0\.0\.1|0\.0\.0\.0):(11434|1234|4000)\b/ },
  { label: 'OpenAI-compatible path', re: /\/v1\/(chat\/completions|messages|responses)\b/ },
  { label: 'AI vendor env var', re: /\b(OMNIROUTE|OPENAI|ANTHROPIC|LITELLM|AI_GATEWAY)_[A-Z_]*\b/ },
  // AWS endpoint overrides are allowed only on lines that point at LocalStack; comment lines are ignored.
  { label: 'AWS_ENDPOINT_URL outside LocalStack', re: /^(?!\s*#)(?![^\n]*(127\.0\.0\.1|localhost|localstack))[^\n]*\bAWS_ENDPOINT_URL(_BEDROCK_RUNTIME)?\b/m },
  { label: 'endpoint option on BedrockRuntimeClient', re: /BedrockRuntimeClient\s*\(\s*\{[^}]*\bendpoint\b/ },
  { label: 'base64-decoded URL', re: new RegExp(`${DECODE}[\\s\\S]{0,200}${URLISH}|${URLISH}[\\s\\S]{0,200}${DECODE}`) },
];

// Join split string literals ('api.open' + 'ai.com') so host patterns see the assembled value.
const prepare = (text) => text.replace(/['"][ \t]*\+[ \t]*['"]/g, '');

const dirs = SCAN_DIRS.map((d) => path.join(repoRoot, d)).filter((d) => fs.existsSync(d));
const rootFiles = fs.existsSync(repoRoot)
  ? fs.readdirSync(repoRoot).filter((f) => ROOT_FILE.test(f)).map((f) => path.join(repoRoot, f)).filter((f) => fs.statSync(f).isFile())
  : [];
// The root manifest counts too: npm hoists its dependencies into node_modules for every workspace.
const rootManifest = path.join(repoRoot, 'package.json');
const rootManifests = fs.existsSync(rootManifest) ? [rootManifest] : [];
if (dirs.length + rootFiles.length + rootManifests.length === 0) finish('SKIP', NAME, `none of ${SCAN_DIRS.join(', ')} exist yet`);

const all = dirs.flatMap((d) => walk(d, { exts: EXTS })).filter((f) => !f.startsWith(EXCLUDED) && path.basename(f) !== 'package-lock.json');
const manifests = [...all.filter((f) => path.basename(f) === 'package.json'), ...rootManifests];
const sources = [...all.filter((f) => !manifests.includes(f)), ...rootFiles];
if (sources.length + manifests.length === 0) finish('SKIP', NAME, `no source files under ${SCAN_DIRS.join(', ')} yet`);

const hits = scanFiles(sources, PATTERNS, { prepare });
for (const manifest of manifests) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    continue;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
  for (const [dep, spec] of Object.entries(deps)) {
    // "npm:openai@^4" aliases install a forbidden package under another name.
    const alias = typeof spec === 'string' && spec.startsWith('npm:') ? spec.slice(4).replace(/(.)@.*$/, '$1') : '';
    if (FORBIDDEN_PACKAGE.test(dep) || FORBIDDEN_PACKAGE.test(alias)) {
      hits.push({ file: path.relative(repoRoot, manifest), line: 1, label: `dependency ${dep}${alias ? ` (${spec})` : ''}` });
    }
  }
}

if (hits.length) finish('FAIL', NAME, `non-Bedrock AI usage: ${formatHits(hits)}`);
finish('PASS', NAME, `${sources.length} source files and ${manifests.length} manifests scanned; only @aws-sdk/client-bedrock-runtime is permitted`);
