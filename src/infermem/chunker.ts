/**
 * chunker —— markdown → 段数组。
 *
 * 决策 #3:输入先支持 markdown。
 * 决策 #2:正文存成 JSON 数组(docs/<docId>/content.json),原子只索引 {segIndex, offset}。
 *
 * 切分:先按标题(#..######)切「节」保留结构;长节再按句/段边界切成 ~2500 token 的「段」,带少量重叠。
 * 纯函数,不碰落盘(store 负责写文件)。
 */

const TARGET_CHARS = 10_000;  // ≈2500 token(中英文均按 ~4 chars/token 估)
const OVERLAP_CHARS = 800;    // ≈200 token 重叠,防边界交叉引用被切断

export function chunkMarkdown(text: string): string[] {
  const sections = splitSections(text);
  const segments: string[] = [];
  for (const sec of sections) {
    if (sec.trim().length === 0) continue;
    if (sec.length <= TARGET_CHARS) segments.push(sec);
    else segments.push(...splitLong(sec));
  }
  return segments;
}

/** 按 markdown 标题切节,标题归入其所属节 */
function splitSections(text: string): string[] {
  const headingRe = /^(#{1,6}\s+.*)$/gm;
  const matches = [...text.matchAll(headingRe)];
  if (matches.length === 0) return [text];

  const sections: string[] = [];
  // 标题前的导言(如果有)作为独立一节
  if (matches[0].index! > 0) {
    const intro = text.slice(0, matches[0].index!);
    if (intro.trim()) sections.push(intro);
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    sections.push(text.slice(start, end));
  }
  return sections;
}

/** 长节 → 重叠段:优先在段落边界切,退而求其次在句边界切 */
function splitLong(section: string): string[] {
  const paras = section.split(/\n{2,}/);
  const segments: string[] = [];
  let buf = '';

  for (const para of paras) {
    if ((buf + para).length > TARGET_CHARS && buf.trim()) {
      segments.push(buf.trim());
      buf = overlapTail(buf) + para;   // 保留尾部作为重叠
    } else {
      buf += (buf ? '\n\n' : '') + para;
    }
  }
  if (buf.trim()) segments.push(buf.trim());

  // 若某段仍超长(单个超长段落),退化为句边界硬切
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.length <= TARGET_CHARS) out.push(seg);
    else out.push(...hardSplit(seg));
  }
  return out;
}

/** 取 buf 尾部重叠:从尾部第一个句末标点之后开始,保证重叠段是完整句子 */
function overlapTail(buf: string): string {
  const t = buf.slice(-OVERLAP_CHARS);
  const cut = t.search(/[。.!?！？]/);
  return cut >= 0 ? t.slice(cut + 1) : t;
}

function hardSplit(text: string): string[] {
  const sentences = text.match(/[^。.!?！？]*[。.!?！？]+|[^。.!?！？]+$/g) ?? [text];
  const segments: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > TARGET_CHARS && buf.trim()) {
      segments.push(buf.trim());
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) segments.push(buf.trim());
  return segments;
}
