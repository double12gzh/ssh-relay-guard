import typescriptEslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
    ...typescriptEslint.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: typescriptEslint.parser,
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules: {
            "@typescript-eslint/naming-convention": ["warn", {
                selector: "import",
                format: ["camelCase", "PascalCase"],
            }],
            "curly": "error",
            "eqeqeq": "error",
            "no-throw-literal": "error",
            "semi": "error",
            "prefer-const": "warn",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }]
        }
    },
    eslintConfigPrettier
];