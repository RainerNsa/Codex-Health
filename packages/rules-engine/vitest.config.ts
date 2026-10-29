import { defineConfig } from 'vitest/config';

// Files run one at a time: the property suites saturate every core, and a CLI spawned by another worker
// meanwhile could stall past its timeout (observed: 1 s suite becoming 2 minutes). Serial is 2 s.
export default defineConfig({ test: { fileParallelism: false } });
