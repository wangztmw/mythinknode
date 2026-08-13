export const DESCRIPTION = `Read a file from the filesystem. Use for reading source code, config, docs.
- Returns content with line numbers (format: "LINE\\tCONTENT").
- Max 2000 lines per read. Use offset+limit for large files.
- Supports .ts, .tsx, .js, .json, .md, .txt, .html, .css, .py, and more.`;
