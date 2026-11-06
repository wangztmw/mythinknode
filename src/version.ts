// 版本号唯一来源：package.json。dist/version.js → ../package.json、src/version.ts → ../package.json 均指向包根。
// 用 createRequire 读，避免 JSON import assertion 在 ESM/tsc 下的兼容问题。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION: string = pkg.version;
