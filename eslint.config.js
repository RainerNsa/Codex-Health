// Root ESLint 9 flat config. Workspaces run `eslint --config ../../eslint.config.js <dir>`.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  ...tseslint.configs.recommended,
);
