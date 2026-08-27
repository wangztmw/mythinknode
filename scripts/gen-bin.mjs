// 生成 bin/ 入口 wrapper。bin/ 不进 git(见 .gitignore)，由 build / prepare 自动生成。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const wrapper = `#!/usr/bin/env node\nimport('../dist/Mythinknode.js');\n`;

mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, 'mythinknode.js'), wrapper);
writeFileSync(join(binDir, 'mtn.js'), wrapper);
