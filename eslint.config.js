import js from '@eslint/js';
import ts from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default ts.config({ignores:['dist/**','target/**','node_modules/**','src-tauri/target/**']},js.configs.recommended,...ts.configs.recommended,{files:['**/*.{ts,tsx}'],plugins:{'react-hooks':hooks},rules:{...hooks.configs.recommended.rules,'@typescript-eslint/no-explicit-any':'off','@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}],'react-hooks/set-state-in-effect':'off','react-hooks/refs':'off'}},{files:['**/*.js'],languageOptions:{globals:{process:'readonly'}}});
