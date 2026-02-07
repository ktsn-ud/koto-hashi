// 参考: https://dev.classmethod.jp/articles/typescript-eslint-v9-and-prettier/

import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    ignores: ['**/cdk.out/'], // AWS CDK プロジェクトの場合、出力ディレクトリを無視
  },
  eslintConfigPrettier,

  /**
   * メインの ESLint 設定（TS/JS 共通）
   */
  {
    files: ['**/*.ts', '**/*.js'], // 必要に応じて jsx や tsx を追加
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      import: importPlugin, // import/export 構文の検証
      '@typescript-eslint': tseslint, // TypeScript 専用ルール
    },

    /**
     * 各ルールの設定
     */
    rules: {
      /**
       * 未使用の変数／引数をエラーに
       * @see https://typescript-eslint.io/rules/no-unused-vars/#how-to-use
       *
       * MEMO: ESLint のデフォルトルールは enum などの特定のケースで誤検出することがあるため、@typescript-eslint のルールを使用
       */
      '@typescript-eslint/no-unused-vars': 'warn',
      'no-unused-vars': 'off', // デフォルトルールは競合回避のため無効化

      /**
       * コールバックを必ずアロー関数で書く
       * @see https://eslint.org/docs/latest/rules/prefer-arrow-callback
       */
      'prefer-arrow-callback': 'error',
    },
  },
];
