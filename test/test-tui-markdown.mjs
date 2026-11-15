// TUI Markdown 软换行/解析回归测试
// 用法: node Plan/cli-test/test-tui-markdown.mjs（需先 npm run build）
import React from 'react';
import { renderToString } from 'ink';
import {
  joinSoftLines,
  parseMarkdown,
  preferredWrapMode,
} from '../dist/cli/tui/render/markdown-parse.js';
import { MarkdownBlock } from '../dist/cli/tui/render/markdown.js';
import { parseInline, wrapSegments } from '../dist/cli/tui/render/inline.js';
import { computeColumnWidths } from '../dist/cli/tui/render/table.js';
import { displayWidth } from '../dist/cli/tui/text/width.js';

let PASS = 0, FAIL = 0;
function assert(name, cond) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}`); }
}

const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

console.log('\n=== TUI Markdown 回归 ===\n');

// ---- 行内解析 ----
{
  const segs = parseInline('普通 **粗体** `代码` *斜体* [链接](https://x.y)');
  assert('行内粗体', segs.some(s => s.bold && s.text === '粗体'));
  assert('行内代码', segs.some(s => s.code && s.text === '代码'));
  assert('行内斜体', segs.some(s => s.italic && s.text === '斜体'));
  assert('链接文本 + URL', segs.some(s => s.text === '链接') && segs.some(s => s.color === 'gray' && s.text.includes('https://x.y')));
}

// ---- CJK 避头尾 ----
{
  const text = '这是一段中文，用来测试避头尾规则。括号（内容）也要正确。';
  const lines = wrapSegments(parseInline(text), 10);
  const joined = lines.map(line => line.map(s => s.text).join('')).join('');
  assert('折行不丢内容', joined === text);
  assert('行首不出现标点', lines.slice(1).every(line => {
    const first = line.map(s => s.text).join('').charAt(0);
    return !'。，、；：！？）〕］｝〉》」』】…‥・：；,.!?)]}'.includes(first);
  }));
  assert('行尾不出现开括号', lines.slice(0, -1).every(line => {
    const s = line.map(x => x.text).join('');
    return !'（〔［｛〈《「『【'.includes(s.slice(-1));
  }));
  assert('每行显示宽不超过限制', lines.every(line =>
    displayWidth(line.map(x => x.text).join('')) <= 10));
}

// ---- 表格列宽 ----
{
  const widths = computeColumnWidths([10, 30, 10], 60);
  assert('列宽总和不超过可用宽度', widths.reduce((a, b) => a + b, 0) <= 60);
  assert('每列至少 4', widths.every(w => w >= 4));
  assert('宽内容列获得更多宽度', widths[1] > widths[0] && widths[1] > widths[2]);

  const tight = computeColumnWidths([100, 100], 30);
  assert('极窄时列宽总和仍不超限', tight.reduce((a, b) => a + b, 0) <= 30);
  assert('极窄时每列至少 4', tight.every(w => w >= 4));

  assert('空表格', computeColumnWidths([], 50).length === 0);
}

// ---- 软换行 ----
{
  assert('中文软换行直接拼接', joinSoftLines(['这是第一行', '这是第二行']) === '这是第一行这是第二行');
  assert('英文软换行用空格', joinSoftLines(['hello', 'world']) === 'hello world');
  assert('中英之间保留空格', joinSoftLines(['中文', 'English']) === '中文 English');
  assert('行尾两空格 = 硬换行', joinSoftLines(['line one  ', 'line two']) === 'line one\nline two');
  assert('行尾反斜杠 = 硬换行', joinSoftLines(['line one\\', 'line two']) === 'line one\nline two');
}

// ---- 折行模式 ----
{
  assert('中文段落用 hard', preferredWrapMode('这是一段中文，应该按字折行。') === 'hard');
  assert('英文段落用 wrap', preferredWrapMode('This is an English paragraph that should wrap by words.') === 'wrap');
  assert('中英混排（中文占比高）用 hard',
    preferredWrapMode('这是一个 mixed 段落，中文占比很高，应该按字折行。') === 'hard');
  assert('英文为主、少量中文用 wrap',
    preferredWrapMode('This is mostly English text with only 一 two Chinese characters.') === 'wrap');
}

// ---- 块解析 ----
{
  const blocks = parseMarkdown('这是第一行\n这是第二行\n\n第二段');
  assert('两个段落', blocks.length === 2);
  assert('段落已合并', blocks[0].type === 'paragraph' && blocks[0].text === '这是第一行这是第二行');
  assert('第二段独立', blocks[1].type === 'paragraph' && blocks[1].text === '第二段');
}

{
  const blocks = parseMarkdown('```ts\nconst a = 1;\nconst b = 2;\n```');
  assert('代码块类型', blocks.length === 1 && blocks[0].type === 'code');
  assert('代码语言', blocks[0].type === 'code' && blocks[0].lang === 'ts');
  assert('代码行原样保留', blocks[0].type === 'code' && blocks[0].lines.length === 2
    && blocks[0].lines[0] === 'const a = 1;');
}

{
  const blocks = parseMarkdown('- 第一行\n  第二行\n- item two');
  assert('列表两个 item', blocks.length === 1 && blocks[0].type === 'list' && blocks[0].items.length === 2);
  assert('中文续行无空格', blocks[0].items[0].text === '第一行第二行');
  assert('英文 item 原样', blocks[0].items[1].text === 'item two');
}

{
  const blocks = parseMarkdown('1. first\n2. second');
  assert('有序列表', blocks[0].type === 'list' && blocks[0].items.every(i => i.ordered));
  assert('保留序号', blocks[0].items[0].marker === '1.' && blocks[0].items[1].marker === '2.');
}

{
  const blocks = parseMarkdown('> line one\n> line two');
  assert('引用合并续行', blocks[0].type === 'quote' && blocks[0].text === 'line one line two');
}

{
  const blocks = parseMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
  assert('表格跳过分隔行', blocks[0].type === 'table' && blocks[0].rows.length === 2);
  assert('表格单元格', blocks[0].rows[0][0] === 'A' && blocks[0].rows[1][1] === '2');
}

{
  const blocks = parseMarkdown('# 标题\n\n---');
  assert('标题层级', blocks[0].type === 'heading' && blocks[0].level === 1);
  assert('分隔线', blocks[1].type === 'rule');
}

// ---- 渲染：宽度自适应 ----
{
  const text = '这是第一行\n这是第二行，继续同一段。';
  const wide = stripAnsi(renderToString(
    React.createElement(MarkdownBlock, { text, columns: 120 }),
    { columns: 120 },
  ));
  assert('宽屏段落合并为一行', wide.includes('这是第一行这是第二行，继续同一段。'));

  const narrow = stripAnsi(renderToString(
    React.createElement(MarkdownBlock, { text, columns: 30 }),
    { columns: 30 },
  ));
  const longLine = narrow.split('\n').find(line => line.length > 34);
  assert('窄屏按容器折行', longLine === undefined);
  assert('窄屏不丢内容', narrow.replace(/\s/g, '').includes('这是第一行这是第二行，继续同一段。'));
}

{
  const listText = '- 这是一个很长的列表项，用来观察换行之后的悬挂缩进是否正确对齐在文字下方，而不是回到最左边。';
  const out = stripAnsi(renderToString(
    React.createElement(MarkdownBlock, { text: listText, columns: 40 }),
    { columns: 40 },
  ));
  const lines = out.split('\n');
  const bulletLine = lines.findIndex(line => line.includes('•'));
  const nextLine = lines[bulletLine + 1] ?? '';
  assert('列表续行悬挂缩进', /^ {4}\S/.test(nextLine));
}

{
  const text = '| A | B |\n|---|---|\n| 1 | 2 |';
  const narrow = stripAnsi(renderToString(
    React.createElement(MarkdownBlock, { text, columns: 40 }),
    { columns: 40 },
  ));
  assert('窄屏表格降级为逐字段', narrow.includes('A:') && narrow.includes('1') && narrow.includes('B:') && narrow.includes('2'));
  assert('窄屏不再用一行拼接', !narrow.includes(' · '));

  const wide = stripAnsi(renderToString(
    React.createElement(MarkdownBlock, { text, columns: 100 }),
    { columns: 100 },
  ));
  assert('宽屏表格保持列对齐', wide.includes('A') && wide.includes('│') && !wide.includes('A: 1'));
}

// ---- 表格单元格内的行内标记 ----
{
  const text = '| 方向 | 说明 |\n|---|---|\n| **生物信息学** | 用 `算法` 读数据 |';
  const wide = stripAnsi(renderToString(
    React.createElement(MarkdownBlock, { text, columns: 100 }),
    { columns: 100 },
  ));
  assert('宽屏表格渲染粗体（不显示 **）', !wide.includes('**') && wide.includes('生物信息学'));
  assert('宽屏表格渲染行内代码（不显示反引号）', !wide.includes('`') && wide.includes('算法'));

  const narrow = stripAnsi(renderToString(
    React.createElement(MarkdownBlock, { text, columns: 40 }),
    { columns: 40 },
  ));
  assert('窄屏表格渲染粗体（不显示 **）', !narrow.includes('**') && narrow.includes('生物信息学'));
  assert('窄屏表格渲染行内代码（不显示反引号）', !narrow.includes('`') && narrow.includes('算法'));
}

{
  // 超长 + 带标记的单元格：截断后不能残留半截标记
  const long = '**这是一段很长很长的粗体单元格内容**'.repeat(5);
  const text = `| A | B |\n|---|---|\n| ${long} | x |`;
  const out = stripAnsi(renderToString(
    React.createElement(MarkdownBlock, { text, columns: 60 }),
    { columns: 60 },
  ));
  assert('表格截断不残留 ** 标记', !out.includes('**'));
  assert('表格截断补省略号', out.includes('…'));
}

console.log(`\n结果: ${PASS} 通过, ${FAIL} 失败\n`);
if (FAIL > 0) process.exit(1);
