/** Read a required environment variable; throw (naming only the variable) when absent or empty. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

/** Bedrock regions the product may call (CONSTRAINTS I7: US regions, under the AWS BAA). */
export const BEDROCK_REGIONS = ['us-east-1', 'us-west-2'] as const;
export type BedrockRegion = (typeof BEDROCK_REGIONS)[number];

// A fully pinned Anthropic model id with a date stamp and version, e.g.
// anthropic.claude-3-5-sonnet-20241022-v2:0. No ":latest", no alias, no cross-region prefix.
const PINNED_MODEL_ID = /^anthropic\.claude-[a-z0-9-]+-\d{8}-v\d+:\d+$/;

export interface BedrockClientConfig {
  region: BedrockRegion;
  modelId: string;
}

/**
 * The only configuration a @codex-health Bedrock client may be built from: a US region, a pinned
 * model id, and no endpoint override. Throws on anything else. Pass the result to
 * `new BedrockRuntimeClient({ region })` in the service that owns the SDK; this package has no AWS SDK.
 */
export function bedrockClientConfig(opts: { region: string; modelId: string; endpoint?: undefined }): BedrockClientConfig {
  if (opts.endpoint !== undefined) {
    throw new Error('bedrockClientConfig: endpoint override is not allowed; the product calls Bedrock directly');
  }
  const region = BEDROCK_REGIONS.find((r) => r === opts.region);
  if (region === undefined) {
    throw new Error(`bedrockClientConfig: region must be one of ${BEDROCK_REGIONS.join(', ')}`);
  }
  if (!PINNED_MODEL_ID.test(opts.modelId)) {
    throw new Error('bedrockClientConfig: modelId must be a pinned anthropic.claude-<name>-<YYYYMMDD>-v<n>:<m> id');
  }
  return { region, modelId: opts.modelId };
}
