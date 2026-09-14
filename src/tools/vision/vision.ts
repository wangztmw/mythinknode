/**
 * 视觉模型调用库
 *
 * 双通路，默认云端优先、本地兜底：
 *   - 云端（首选）：deepseek-flash（原生多模态），走 openaiBase + apiKey，实测约 0.7s/张，
 *     比本地 Qwen3-VL-8B 快 ~15x。大图先转 jpeg（长边 ≤ 1568）再上传。
 *   - 本地（兜底）：Qwen3-VL-8B，跑在专用端口 8081，按需启停：
 *       · 用前 ensureVisionServer()：探测 /health → 没开就拉起 run-server.sh（MODEL=VL PORT=8081）
 *       · 用后 scheduleVisionStop()：重置 3 分钟 idle 倒计时，超时无新调用才停
 *       · 大图先降采样（长边 > 1024 → sips 压到 1024），避免 M2 上大图 prefill 90-180s 超时
 *       · 进程退出兜底：'exit' 事件同步 SIGTERM 杀掉 detached llama-server
 *
 * 通路选择：MYTHINKNODE_VISION 环境变量 或 config.json 的 visionProvider 键
 *   'auto'（默认）= 云端失败自动回退本地；'cloud' = 只用云端；'local' = 只用本地。
 * 云端模型名：MYTHINKNODE_VISION_MODEL 或 config.json 的 visionModel 键（默认 deepseek-flash）。
 *
 * 这是「可调用的代码库」：VisionTool 只是它的薄封装，也可被其它模块直接 import。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ConfigStore } from '../../config.js';

export const VISION_BASE = 'http://127.0.0.1:8081';
export const VISION_MODEL = 'qwen3-vl-8b';
export const CLOUD_VISION_MODEL = 'deepseek-flash';
const VISION_PORT = '8081';
const START_TIMEOUT_S = 120;   // VL 加载约 5-8s，留足余量
const CALL_TIMEOUT_MS = 180_000;     // 本地：大图 prefill 慢，给足
const CLOUD_TIMEOUT_MS = 60_000;     // 云端：正常 <5s，60s 兜底
const IDLE_STOP_MS = 3 * 60 * 1000;  // 3 分钟无新调用后自动停
const MAX_EDGE = 1024;               // 本地降采样长边上限（像素）
const CLOUD_MAX_EDGE = 1568;         // 云端降采样长边上限（DeepSeek 图片 token 到 ~1017 封顶，1568 足够）
const CLOUD_JPEG_QUALITY = '85';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
};

const TASK_PROMPTS: Record<string, string> = {
  latex:
    '请把图片中的数学公式准确转换为 LaTeX 代码。只输出 LaTeX，不要解释，不要加 markdown 代码块标记；每个公式独立用 $$...$$ 包裹。',
  markdown:
    '请把图片中的文档内容转换为 Markdown。保留标题、段落、列表、表格结构；数学公式转换为 LaTeX（用 $$...$$ 包裹）；不要添加原文没有的内容。',
  describe: '请详细描述这张图片的内容。',
};

export type VisionProvider = 'auto' | 'cloud' | 'local';

interface VisionConfig {
  provider: VisionProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** 是否保留推理模型的思考过程（默认 false：关闭，否则 token 会被 reasoning 吃光、content 为空） */
  thinking: boolean;
}

/** 解析视觉通路配置：环境变量 > config.json > 默认值 */
export function resolveVisionConfig(): VisionConfig {
  const file = ConfigStore._loadFile() as Record<string, unknown>;
  const envProvider = process.env.MYTHINKNODE_VISION as VisionProvider | undefined;
  const fileProvider = file.visionProvider as VisionProvider | undefined;
  const provider = envProvider || fileProvider || 'auto';
  const baseUrl = (process.env.OPENAI_BASE_URL || (file.openaiBase as string) || 'https://api.deepseek.com')
    .replace(/\/+$/, '').replace(/\/v1$/, '');
  return {
    provider: ['auto', 'cloud', 'local'].includes(provider) ? provider : 'auto',
    model: process.env.MYTHINKNODE_VISION_MODEL || (file.visionModel as string) || CLOUD_VISION_MODEL,
    apiKey: process.env.MYTHINKNODE_API_KEY || (file.apiKey as string) || '',
    baseUrl,
    thinking: process.env.MYTHINKNODE_VISION_THINKING === '1' || file.visionThinking === true,
  };
}

function scriptsDir(): string {
  return (
    process.env.MYTHINKNODE_VISION_SCRIPTS
    || join(homedir(), 'Desktop', 'llmtest', '01-nanogpt', '本地大模型', 'scripts')
  );
}

function pidFile(): string {
  return join(dirname(scriptsDir()), 'logs', 'llama-server-vl.pid');
}

function readPid(): number | null {
  try {
    const pid = Number(readFileSync(pidFile(), 'utf-8').trim());
    if (!Number.isFinite(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch { return null; }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function healthCheck(timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${VISION_BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}

// ---- idle 自动停止（3 分钟无新调用后自动关，释放 16GB 内存）----

let idleTimer: NodeJS.Timeout | null = null;

function clearIdleTimer(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

/** 取消待触发的 idle 停止（新调用进来前调用，避免刚 ready 又被 timer 关掉）。 */
export function cancelVisionStop(): void {
  clearIdleTimer();
}

/** 每次调用后调用：重置 3 分钟倒计时，超时无新调用则停止服务。
 *  仅在确实有本地服务在跑（pidfile 存在）时才挂定时器——否则云端通路会平白吊住进程 3 分钟。 */
export function scheduleVisionStop(): void {
  clearIdleTimer();
  if (!readPid()) return;   // 没有本地服务可停（如走云端通路）→ 不挂定时器
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void stopVisionServer();
  }, IDLE_STOP_MS);
}

// ---- 进程退出兜底：同步发 SIGTERM（'exit' 事件只能同步，不能 await）----

let exitHooked = false;
function hookExitCleanup(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    const pid = readPid();
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* 已死 */ } }
  });
}
hookExitCleanup();

/** 确保本地视觉模型在运行：没开就拉起，并等待就绪。 */
export async function ensureVisionServer(): Promise<void> {
  cancelVisionStop();   // 即将使用，取消可能挂起的 idle 停止
  if (await healthCheck()) return;

  // 已有存活进程（可能正在加载）→ 直接等它起来，不重复 spawn
  if (!readPid()) {
    const script = join(scriptsDir(), 'run-server.sh');
    if (!existsSync(script)) {
      throw new Error(
        `视觉模型启动脚本不存在: ${script}\n请先下载 Qwen3-VL-8B（见 本地大模型/多模态模型.md）`
      );
    }
    const child = spawn('bash', [script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, MODEL: 'VL', PORT: VISION_PORT },
    });
    child.unref();
    try { writeFileSync(pidFile(), String(child.pid ?? ''), 'utf-8'); } catch { /* 忽略 */ }
  }

  for (let i = 0; i < START_TIMEOUT_S; i++) {
    await sleep(1000);
    if (await healthCheck()) return;
  }
  throw new Error(`视觉模型启动超时(${START_TIMEOUT_S}s)。请手动 MODEL=VL ./scripts/run-server.sh 排查日志`);
}

/** 停止本地视觉模型（读 PID 精确 kill，不误伤 8080 的文本模型）。 */
export async function stopVisionServer(): Promise<void> {
  const pid = readPid();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 已死 */ }
    for (let i = 0; i < 20 && readPid(); i++) await sleep(300);
    if (readPid()) { try { process.kill(pid, 'SIGKILL'); } catch { /* 忽略 */ } }
  }
  try { rmSync(pidFile(), { force: true }); } catch { /* 忽略 */ }
}

/**
 * 本地通路降采样：长边 > MAX_EDGE 时用 sips 压成临时 png，返回临时文件路径；
 * 否则原样返回原路径。sips 失败则退回原图（宁可慢，不可错）。
 */
function downsampleIfLarge(imagePath: string): string {
  try {
    const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', imagePath], { encoding: 'utf-8' });
    const w = parseInt(info.match(/pixelWidth:\s*(\d+)/)?.[1] ?? '0', 10);
    const h = parseInt(info.match(/pixelHeight:\s*(\d+)/)?.[1] ?? '0', 10);
    if (w > 0 && h > 0 && w <= MAX_EDGE && h <= MAX_EDGE) return imagePath;

    const tmp = join(tmpdir(), `vision-down-${process.pid}-${Date.now()}.png`);
    execFileSync('sips', ['-Z', String(MAX_EDGE), imagePath, '--out', tmp], { stdio: 'ignore' });
    return existsSync(tmp) ? tmp : imagePath;
  } catch {
    return imagePath;   // sips 不可用/失败 → 退回原图
  }
}

/**
 * 云端通路降采样：统一转 jpeg（长边 ≤ CLOUD_MAX_EDGE，质量 85），压小上传体积。
 * 失败则退回原图。
 */
function toCloudJpeg(imagePath: string): string {
  try {
    const tmp = join(tmpdir(), `vision-cloud-${process.pid}-${Date.now()}.jpg`);
    execFileSync('sips', [
      '-Z', String(CLOUD_MAX_EDGE), imagePath,
      '-s', 'format', 'jpeg', '-s', 'formatOptions', CLOUD_JPEG_QUALITY,
      '--out', tmp,
    ], { stdio: 'ignore' });
    return existsSync(tmp) ? tmp : imagePath;
  } catch {
    return imagePath;
  }
}

export interface VisionResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface ChatResult {
  choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** 统一抽取 OpenAI 兼容响应里的文本 + usage。 */
function extractResult(d: ChatResult): VisionResult {
  const msg = d.choices?.[0]?.message;
  let text = '';
  if (typeof msg?.content === 'string') text = msg.content;
  else if (Array.isArray(msg?.content)) {
    text = msg.content.filter(b => b.type === 'text').map(b => b.text || '').join('');
  }
  return { text, inputTokens: d.usage?.prompt_tokens, outputTokens: d.usage?.completion_tokens };
}

function isError(r: VisionResult): boolean { return r.text.startsWith('Error:'); }

function cleanup(path: string, original: string): void {
  if (path !== original) { try { rmSync(path, { force: true }); } catch { /* 忽略 */ } }
}

/**
 * 云端通路：deepseek-flash（或 visionModel 指定）→ 文本。
 */
async function analyzeImageCloud(
  imagePath: string,
  prompt: string,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<VisionResult> {
  const cfg = resolveVisionConfig();
  if (!cfg.apiKey) return { text: 'Error: 云端视觉未配置 apiKey（~/.mythinknode/config.json 的 apiKey）' };

  if (!existsSync(imagePath)) return { text: `Error: 图片不存在或不可读: ${imagePath}` };

  const effectivePath = toCloudJpeg(imagePath);
  let buf: Buffer;
  try { buf = readFileSync(effectivePath); }
  catch {
    cleanup(effectivePath, imagePath);
    return { text: `Error: 图片不存在或不可读: ${imagePath}` };
  }
  const b64 = buf.toString('base64');
  cleanup(effectivePath, imagePath);

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
      ],
    }],
    max_tokens: opts?.maxTokens ?? 8192,
  };
  if (opts?.temperature != null) body.temperature = opts.temperature;

  // DeepSeek 视觉模型是推理模型：不解思考的话会烧光全部 max_tokens 只输出 reasoning_content，
  // content 恒为空（实测 900/3000 token 全被 reasoning 吃满，finish_reason=length）。
  // thinking:{type:'disabled'} 实测 3.6s 完成且正常出 content（基线 21.4s 且空）。
  // 仅对 DeepSeek 端点下发，避免污染其它 OpenAI 兼容服务。
  if (!cfg.thinking && cfg.baseUrl.includes('deepseek')) {
    body.thinking = { type: 'disabled' };
  }

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
  } catch (e) {
    return { text: `Error: 云端视觉请求失败: ${(e as Error).message}` };
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { text: `Error: 云端视觉 API ${res.status}: ${t.slice(0, 300)}` };
  }
  return extractResult(await res.json() as ChatResult);
}

/**
 * 本地通路：Qwen3-VL-8B（端口 8081）→ 文本。调用前请确保服务已就绪（见 analyzeImage）。
 */
async function analyzeImageLocal(
  imagePath: string,
  prompt: string,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<VisionResult> {
  if (!existsSync(imagePath)) {
    return { text: `Error: 图片不存在或不可读: ${imagePath}` };
  }

  // 大图降采样（长边 > 1024），临时文件读完后立即清理
  const effectivePath = downsampleIfLarge(imagePath);
  const isTemp = effectivePath !== imagePath;

  const ext = effectivePath.split('.').pop()?.toLowerCase() || '';
  const mime = MIME[ext];
  if (!mime) {
    if (isTemp) try { rmSync(effectivePath, { force: true }); } catch { /* 忽略 */ }
    return { text: `Error: 不支持的图片格式 ".${ext}"（支持 ${Object.keys(MIME).join('/')}）` };
  }

  let buf: Buffer;
  try { buf = readFileSync(effectivePath); }
  catch {
    if (isTemp) try { rmSync(effectivePath, { force: true }); } catch { /* 忽略 */ }
    return { text: `Error: 图片不存在或不可读: ${imagePath}` };
  }

  const b64 = buf.toString('base64');
  if (isTemp) { try { rmSync(effectivePath, { force: true }); } catch { /* 忽略 */ } }

  const body = {
    model: VISION_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
    temperature: opts?.temperature ?? 0.1,
    max_tokens: opts?.maxTokens ?? 4096,
  };

  const res = await fetch(`${VISION_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-local' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { text: `Error: 视觉模型 API ${res.status}: ${t.slice(0, 300)}` };
  }
  return extractResult(await res.json() as ChatResult);
}

/**
 * 核心：图片 → 视觉模型 → 文本。
 * 默认云端 deepseek-flash 优先（~0.7s/张），失败自动回退本地 Qwen3-VL-8B（~10s/张）。
 * provider='cloud' 时只用云端；'local' 时只用本地。
 * @param imagePath 图片绝对路径（png/jpg/jpeg/gif/webp/bmp）
 * @param prompt    任务说明（可传自定义，或用 taskPrompt()）
 */
export async function analyzeImage(
  imagePath: string,
  prompt: string,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<VisionResult> {
  const cfg = resolveVisionConfig();
  let cloudErr = '';

  if (cfg.provider === 'cloud' || cfg.provider === 'auto') {
    const r = await analyzeImageCloud(imagePath, prompt, opts);
    if (!isError(r)) return r;
    if (cfg.provider === 'cloud') return r;
    cloudErr = r.text;   // auto → 记录失败原因，继续本地兜底
  }

  try {
    await ensureVisionServer();
  } catch (e) {
    return { text: cloudErr ? `${cloudErr}\n[本地兜底不可用] ${(e as Error).message}` : `Error: ${(e as Error).message}` };
  }

  const r = await analyzeImageLocal(imagePath, prompt, opts);
  if (isError(r) && cloudErr) return { text: `${cloudErr}\n[本地兜底] ${r.text}` };
  return r;
}

/** 预置任务提示词（latex/markdown/describe） */
export function taskPrompt(task: string): string {
  return TASK_PROMPTS[task] ?? TASK_PROMPTS.latex;
}
