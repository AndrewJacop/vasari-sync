import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  {
    files: ["**/*.ts"],
    extends: tseslint.configs.recommended,
  },
);
