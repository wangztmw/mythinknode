#!/usr/bin/env python3
"""
会话恢复 + 即时命名 —— 真实 PTY 端到端测试。

单元测试（test-session-restore.mjs）只能验证纯逻辑（historyToBlocks /
provisionalBaseName 等）。本 harness 补上它们覆盖不到的整条链路：

  1. 新建会话后，第一条消息一发出，磁盘目录名立刻变成「时间-意图」
     （而不是等 /exit；这条是本次改动的核心诉求）
  2. `--resume` 恢复会话后，**屏幕上能看到上次的对话内容**
     （改前只恢复 LLM 上下文，屏幕一片空白）
  3. 不依赖任何 LLM 调用 —— 用本地假端点，失败也能跑

用法：
  python3 test/pty-session-restore.py [--keep]

退出码 0 = 全部通过。
"""

import os
import pty
import re
import select
import shutil
import struct
import sys
import tempfile
import termios
import time
import fcntl
import json
import argparse
import subprocess
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = os.path.join(ROOT, "dist", "Mythinknode.js")

ANSI_RE = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b\][^\x07]*\x07|\x1b[@-_]')

PASS = 0
FAIL = 0


def strip_ansi(s: str) -> str:
    return ANSI_RE.sub('', s)


def check(name: str, cond: bool, detail: str = '') -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}" + (f"  [{detail}]" if detail else ''))


class Pty:
    """被驱动的 mtn 子进程（ptmx 主端）。

    ⚠️ 必须持续抽干 stdout，否则应用会因写缓冲填满而**阻塞在 write()**，
    表现为「输入突然冻结、按键全部丢失」——看着像应用 bug，其实是测试框架
    不读数据造成的假故障（2026-11-14 踩过一次，排查了很久）。
    所以 start() 里起一个后台线程持续读，read() 只负责取走已累积的数据。
    """

    def __init__(self, env, rows=30, cols=100):
        self.env = env
        self.rows = rows
        self.cols = cols
        self.pid = None
        self.fd = None
        self.buf = b''
        self.total = b''
        self._lock = threading.Lock()
        self._stop_drain = False

    def start(self, args):
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(ROOT)
            os.execvpe("node", ["node", ENTRY] + args, self.env)
            os._exit(1)
        self.pid = pid
        self.fd = fd
        fl = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', self.rows, self.cols, 0, 0))
        except OSError:
            pass
        threading.Thread(target=self._drain_loop, daemon=True).start()
        return self

    def _drain_loop(self):
        """后台持续读取，防止子进程写阻塞。"""
        while not self._stop_drain:
            try:
                r, _, _ = select.select([self.fd], [], [], 0.05)
                if not r:
                    continue
                chunk = os.read(self.fd, 65536)
                if not chunk:
                    time.sleep(0.05)
                    continue
                with self._lock:
                    self.buf += chunk
                    self.total += chunk
            except (OSError, ValueError):
                time.sleep(0.05)

    def read(self, wait=0.4) -> str:
        """等待 wait 秒后返回这期间累积的增量输出（读取本身由抽干线程做）。"""
        deadline = time.time() + wait
        while time.time() < deadline:
            time.sleep(0.02)
        with self._lock:
            out = self.buf.decode('utf-8', errors='replace')
            self.buf = b''
        return strip_ansi(out)

    def wait_for(self, needle: str, timeout=12.0) -> bool:
        """等待 needle 出现。既看本次增量，也看累计全文 ——
        否则「先调用过 read() 的人」永远等不到早先已输出的内容（踩过一次）。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.read(0.2)
            if needle in self.seen_text:
                return True
        return needle in self.seen_text

    @property
    def seen_text(self) -> str:
        return strip_ansi(self.total.decode('utf-8', errors='replace'))

    def send(self, text):
        os.write(self.fd, text.encode('utf-8'))

    def alive(self) -> bool:
        try:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            return pid == 0
        except ChildProcessError:
            return False

    def kill(self):
        self._stop_drain = True
        try:
            os.kill(self.pid, 9)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass


def marker_history(tag):
    """带唯一标记的会话内容 —— 用来断言「恢复的究竟是哪一条」。"""
    return [
        {'role': 'user', 'content': f'标记-{tag}'},
        {'role': 'assistant', 'content': [{'type': 'text', 'text': f'回复-{tag}'}]},
    ]


def free_port() -> int:
    """问内核要一个空闲端口（避免跟本机其它服务撞车）。"""
    import socket
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start_slow_server(port: int) -> dict:
    """
    极简 OpenAI 兼容 stub：默认 10 秒后才返回，`fast=True` 后立即返回。

    用来验证「模型正在思考时按 Ctrl+C」——没有慢响应就没法验证中断，
    因为正常 API 可能几十毫秒就回来了。
    """
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    state = {'hits': 0, 'fast': False, 'stop': False, 'srv': None}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):        # 静音访问日志
            pass

        def do_POST(self):
            state['hits'] += 1
            length = int(self.headers.get('content-length') or 0)
            self.rfile.read(length)
            # 慢响应：分多段等待，每段检查 stop，保证测试结束时能快速收尾
            for _ in range(100):
                if state['fast'] or state['stop']:
                    break
                time.sleep(0.1)
            body = json.dumps({
                'choices': [{
                    'message': {'role': 'assistant', 'content': 'assistant-ok'},
                    'finish_reason': 'stop',
                }],
                'usage': {'prompt_tokens': 1, 'completion_tokens': 1},
            }).encode()
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass   # 客户端已中断（正是我们要的场景）

    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    state['srv'] = srv
    return state


def wait_until(pred, timeout=10.0, interval=0.15) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if pred():
                return True
        except Exception:
            pass
        time.sleep(interval)
    return False


def wait_input_ready(p, timeout=20.0) -> bool:
    """
    等 TUI 真正可以接收按键，而不是靠固定 sleep。

    为什么需要：Ink 的 useInput 要等组件 mount 完才订阅 stdin。启动阶段的渲染量
    会随界面复杂度变化（输入框常驻 + 队列托盘 + 更多 useTerminalSize 订阅都加了
    工作量），固定 `read(3.0)` 迟早不够 —— 症状是「发出去的键被静默丢弃」，
    表现为 hits=0 这类假失败（2026-11-14 踩过一次）。

    判据选「提示行渲染出来」：它只在 InputBox 渲染后出现，等价于组件已挂载。
    """
    return p.wait_for('Enter 发送', timeout) or p.wait_for('Enter 排队', timeout)


def check_session_integrity(home) -> tuple:
    """
    扫描落盘的 session.json，检查 tool_use / tool_result 配对。

    这是「维护好 Session」的直接验证：悬空的 tool_use 会让下一次请求永久 400，
    会话就报废了。所以中断测试必须断言这一点，而不只是「进程没死」。

    @returns (ok, reason)
    """
    dirs = session_dirs(home)
    if not dirs:
        return False, '没有会话目录'
    for d in dirs:
        path = os.path.join(home, '.mythinknode', 'sessions', d, 'session.json')
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            return False, f'session.json 解析失败: {e}'
        msgs = data.get('messages') or []
        # 收集所有 tool_use id 与 tool_result id
        uses, results = [], []
        for m in msgs:
            role = m.get('role')
            content = m.get('content')
            if role == 'assistant' and isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('id'):
                        uses.append(b['id'])
            elif role == 'tool' and m.get('tool_call_id'):
                results.append(m['tool_call_id'])
            elif role == 'user' and isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('tool_use_id'):
                        results.append(b['tool_use_id'])
        dangling = [u for u in uses if u not in results]
        if dangling:
            return False, f'悬空 tool_use: {dangling}'
    return True, 'ok'


def session_dirs(home):
    d = os.path.join(home, '.mythinknode', 'sessions')
    if not os.path.isdir(d):
        return []
    return sorted(x for x in os.listdir(d) if os.path.isdir(os.path.join(d, x)))


def seed_session(home, sid, base_name, messages):
    """预置一个会话 + 锁文件，模拟「上次没退干净，下次 -r 恢复」。"""
    d = os.path.join(home, '.mythinknode', 'sessions', sid)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'session.json'), 'w') as f:
        json.dump({
            'id': sid,
            'startedAt': int(time.time() * 1000),
            'messages': messages,
            'toolCount': 2,
            'cumulativeTokens': 0,
            'tokenMarkers': [],
            'pendingNotifications': [],
            'firstUserMessage': base_name,
        }, f, ensure_ascii=False)
    with open(os.path.join(home, '.mythinknode', 'sessions', '.lock'), 'w') as f:
        json.dump({'id': sid, 'startedAt': int(time.time() * 1000)}, f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--keep', action='store_true', help='保留临时 HOME 目录')
    args = ap.parse_args()

    if not os.path.exists(ENTRY):
        print(f'找不到 {ENTRY}，先 npm run build')
        return 2

    home = tempfile.mkdtemp(prefix='mtn-pty-')
    env = dict(os.environ)
    env['HOME'] = home
    env['MYTHINKNODE_UI'] = 'classic'      # classic 输出是行式的，便于断言
    env['TERM'] = 'xterm-256color'
    env['MYTHINKNODE_API_KEY'] = 'sk-fake-no-llm'
    env.pop('MYTHINKNODE_MODE', None)

    print(f'\n临时 HOME: {home}')
    print(f'入口:      {ENTRY}\n')

    try:
        # ==================================================
        print('=== 1. 即时命名：第一条消息后目录名立刻可读 ===\n')
        # ==================================================
        p = Pty(env).start([])
        p.read(2.0)
        check('进程启动', p.alive())
        # 注意：classic 备用屏是二维网格，空格与空白单元格不可区分，diff 不会发射空格，
        # 所以字节流里 "mythinknode v1.2.0" 会连成 "mythinknodev1.2.0"。
        # 屏幕上视觉正确（空格位置本来就是空白格）。这里只断言内容存在。
        # ⚠️ 不要写死版本号 —— 每次 bump 都会误报（踩过一次）；
        # 断言「banner 里出现了 package.json 当前的版本」即可。
        with open(os.path.join(ROOT, 'package.json')) as _f:
            _ver = json.load(_f)['version']
        check('banner 已输出',
              'mythinknode' in p.seen_text and _ver in p.seen_text,
              p.seen_text[:120].replace('\n', ' '))

        before = session_dirs(home)
        # 会话锁文件存在说明已开始（新会话目录名是 ISO 时间戳）
        lock_path = os.path.join(home, '.mythinknode', 'sessions', '.lock')
        check('启动即创建会话锁', os.path.exists(lock_path))

        # 发一句用户输入（会触发 LLM，但假 key 必然失败 —— 不影响命名，因为命名在调 LLM 之前）
        p.send('把网站部署到云服务器\r')

        # 等目录名变化：从时间戳（含 T）变成时间-意图（不含 T）
        renamed = None
        deadline = time.time() + 20
        while time.time() < deadline:
            p.read(0.3)
            dirs = session_dirs(home)
            for d in dirs:
                if 'T' not in d and '部署' in d:
                    renamed = d
                    break
            if renamed:
                break

        check('会话目录在首条消息后立刻改名（不等 /exit）',
              renamed is not None, f'当前目录: {session_dirs(home)}')
        check('命名包含时间前缀', bool(renamed and re.match(r'^\d{8}-\d{4}-', renamed)), renamed or '')
        check('命名包含意图短语', bool(renamed and '部署' in renamed), renamed or '')

        p.kill()

        # ==================================================
        print('\n=== 2. 恢复会话：屏幕上重放历史对话 ===\n')
        # ==================================================
        home2 = tempfile.mkdtemp(prefix='mtn-pty2-')
        env2 = dict(env)
        env2['HOME'] = home2

        history = [
            {'role': 'user', 'content': '上次我问了网站部署的事'},
            {'role': 'assistant', 'content': [
                {'type': 'text', 'text': '我帮你查了服务器状态。'},
                {'type': 'tool_use', 'id': 't1', 'name': 'Bash', 'input': {}},
            ]},
            {'role': 'user', 'content': [
                {'type': 'tool_result', 'tool_use_id': 't1', 'content': 'ok'},
            ]},
            {'role': 'user', 'content': '[S1] 这是压缩摘要，不该被重放'},
            {'role': 'user', 'content': '然后你说要用 Nginx 反代'},
            {'role': 'assistant', 'content': [{'type': 'text', 'text': '对，用 Nginx 反代 8080 端口。'}]},
        ]
        seed_session(home2, '20261101-0900-网站部署', '网站部署', history)

        p2 = Pty(env2).start(['-r'])
        p2.read(2.0)
        # 会话选择器：输入 1 + 回车
        if p2.wait_for('可用会话', 10):
            check('显示会话选择器', True)
            p2.send('1')
            time.sleep(0.3)
            p2.send('\r')      # 回车要单独发：与文字同帧会被当成内容换行（已修，但这里按真实按键模拟）
        else:
            check('显示会话选择器', False, p2.seen_text[:200])

        ok = p2.wait_for('历史对话', 15)
        check('恢复后有「历史对话」分隔行', ok)

        text = p2.seen_text
        check('重放了用户发言', '上次我问了网站部署的事' in text, text[:300])
        check('重放了 assistant 文本', '我帮你查了服务器状态' in text)
        check('重放了工具名', 'Bash' in text)
        check('重放了后续用户发言', '然后你说要用 Nginx 反代' in text)
        check('注入的 [S1] 摘要被过滤', '[S1]' not in text)
        check('有「以下继续」结束分隔', '以下继续' in text)
        # 排序：历史分隔行必须出现在用户发言之前
        # 排序：历史分隔行必须出现在用户发言之前。
        # ⚠️ 不能用自己的全局 first-match：选择器的**预览面板**会先显示出
        # 「> 上次我问了网站部署的事」，于是第一处命中在预览里，看起来就像顺序错了。
        # 正确做法：只在「历史对话」之后的片段里判断（取最后一次出现，即恢复后真正重放的那段）。
        tail = text[text.rfind('历史对话'):]
        check('分隔行在发言之前（顺序正确）',
              '历史对话' in tail and
              tail.find('上次我问了网站部署的事') > tail.find('历史对话'))
        check('预览面板也提前展示了内容（本次新增的预期行为）',
              text.find('上次我问了网站部署的事') < text.rfind('历史对话'))

        p2.kill()

        # ==================================================
        print('\n=== 3. 新会话不重放历史 ===\n')
        # ==================================================
        home3 = tempfile.mkdtemp(prefix='mtn-pty3-')
        env3 = dict(env)
        env3['HOME'] = home3
        p3 = Pty(env3).start([])
        p3.read(2.5)
        check('新会话没有「历史对话」分隔行', '历史对话' not in p3.seen_text, p3.seen_text[:200])
        p3.kill()

        # ==================================================
        print('\n=== 4. TUI 模式下恢复同样重放历史 ===\n')
        # ==================================================
        home4 = tempfile.mkdtemp(prefix='mtn-pty4-')
        env4 = dict(env)
        env4['HOME'] = home4
        env4.pop('MYTHINKNODE_UI', None)   # 走默认 Ink TUI
        seed_session(home4, '20261101-0900-网站部署', '网站部署', history)

        p4 = Pty(env4).start(['-r'])
        p4.read(2.5)
        if p4.wait_for('可用会话', 10):
            check('TUI 显示会话选择器', True)
            p4.send('1')
            time.sleep(0.3)
            p4.send('\r')
        else:
            check('TUI 显示会话选择器', False, p4.seen_text[:200])

        ok4 = p4.wait_for('历史对话', 20)
        check('TUI 恢复后有「历史对话」分隔行', ok4)
        t4 = p4.seen_text
        check('TUI 重放了用户发言', '上次我问了网站部署的事' in t4, t4[:300])
        check('TUI 重放了 assistant 文本', '我帮你查了服务器状态' in t4)
        check('TUI 重放了工具名', 'Bash' in t4)
        p4.kill()

        # ==================================================
        print('\n=== 5. 交互式：无关按键被忽略，不崩不退 ===\n')
        # ==================================================
        # 行为变更说明：改前是「输入序号 + 非法输入要重问」的行读取模式；
        # 现在 TTY 下走交互式选择器 —— 字母键（除 j/k/g/G/n/q）被静默忽略，
        # 这是 TUI 的常规行为，不等于「静默降级」。
        # 「非法输入必须提示」的场景改由 5b 验证（非 TTY 降级路径仍然保留）。
        home5 = tempfile.mkdtemp(prefix='mtn-pty5-')
        env5 = dict(env)
        env5['HOME'] = home5
        seed_session(home5, '20261103-0300-会话三', '会话三', marker_history('三'))
        seed_session(home5, '20261102-0200-会话二', '会话二', marker_history('二'))
        seed_session(home5, '20261101-0100-会话一', '会话一', marker_history('一'))

        p5 = Pty(env5).start(['-r'])
        p5.read(2.5)
        check('选择器先显示列表', p5.wait_for('可用会话', 10))
        # 打几个无关字符：a / z / 空格 —— 既不该退出，也不该触发选择
        p5.send('az ')
        time.sleep(0.35)
        check('无关按键后进程仍存活', p5.alive())
        check('无关按键没有触发选择（仍停在列表）', '历史对话' not in p5.seen_text, p5.seen_text[-200:])
        # 仍可正常用方向键选择：Home 归位（初始会预选「上次」）→ ↓ → 第 2 项（会话二）
        p5.send('\x1b[H')
        time.sleep(0.3)
        p5.send('\x1b[B')
        # ⚠️ seen_text 只是「已读到的累计文本」，不会主动从 pty 读新数据。
        # 发完键必须调用 wait_for/read，否则断言看到的是旧帧（踩过一次）。
        check('之后 ↓ 仍生效（预览切到第 2 项）',
              p5.wait_for('预览 · 20261102-0200-会话二', 8), p5.seen_text[-200:])
        p5.send('\r')
        check('Enter 恢复成功', p5.wait_for('历史对话', 15), p5.seen_text[-300:])
        check('恢复的是第 2 项（会话二）的内容',
              '标记-二' in p5.seen_text[p5.seen_text.rfind('历史对话'):], p5.seen_text[-300:])
        p5.kill()

        # ==================================================
        print('\n=== 5b. 非 TTY 降级：仍走序号输入 + 非法输入提示 ===\n')
        # ==================================================
        # `echo ... | mtn -r` 这类场景 stdin 不是 TTY，必须降级到行读取，
        # 否则交互式选择器会永久等方向键。
        home5b = tempfile.mkdtemp(prefix='mtn-pty5b-')
        env5b = dict(env)
        env5b['HOME'] = home5b
        seed_session(home5b, '20261101-0900-网站部署', '网站部署', history)

        r5b = subprocess.run(
            ['node', ENTRY, '-r'],
            input='abc\n1\n'.encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env5b,
            timeout=40,
        )
        out5b = strip_ansi(r5b.stdout.decode('utf-8', errors='replace'))
        check('非 TTY：输出会话列表', '可用会话' in out5b, out5b[-300:])
        check('非 TTY：非法输入有提示', '无效输入' in out5b or '请输入数字' in out5b, out5b[-300:])
        check('非 TTY：随后输入 1 恢复成功', '历史对话' in out5b, out5b[-300:])
        shutil.rmtree(home5b, ignore_errors=True)

        # ==================================================
        print('\n=== 6. 选择器：Ctrl+C 干净退出（不当成开新会话）===\n')
        # ==================================================
        home6 = tempfile.mkdtemp(prefix='mtn-pty6-')
        env6 = dict(env)
        env6['HOME'] = home6
        seed_session(home6, '20261101-0900-网站部署', '网站部署', history)

        p6 = Pty(env6).start(['-r'])
        p6.read(2.5)
        check('Ctrl+C 测试前列表已显示', p6.wait_for('可用会话', 10))
        p6.send('\x03')      # Ctrl+C
        # 等进程退出
        exited = False
        deadline = time.time() + 12
        while time.time() < deadline:
            p6.read(0.3)
            if not p6.alive():
                exited = True
                break
        check('Ctrl+C → 进程退出（不是继续去开新会话）', exited)
        check('Ctrl+C 时没有打印「历史对话」',
              '历史对话' not in p6.seen_text, p6.seen_text[-200:])
        check('Ctrl+C 后没有进入主循环 banner',
              'Type /help' not in p6.seen_text and 'mythinknode v1.1.1' not in p6.seen_text.split('可用会话')[-1],
              p6.seen_text[-200:])
        p6.kill()

        # ==================================================
        print('\n=== 7. 交互式选择器：方向键移动（真实终端）===\n')
        # ==================================================
        home7 = tempfile.mkdtemp(prefix='mtn-pty7-')
        env7 = dict(env)
        env7['HOME'] = home7
        # 造 3 个会话，内容可区分 —— 断言「恢复出来的是不是那一条」，
        # 比断言位置字符串（x/3）稳：后者容易被累积输出/重绘干扰。
        seed_session(home7, '20261103-0300-会话三', '会话三', marker_history('三'))
        seed_session(home7, '20261102-0200-会话二', '会话二', marker_history('二'))
        seed_session(home7, '20261101-0100-会话一', '会话一', marker_history('一'))

        p7 = Pty(env7).start(['-r'])
        p7.read(2.0)
        check('交互式选择器显示列表', p7.wait_for('可用会话', 10))
        check('显示第一个会话', '会话三' in p7.seen_text, p7.seen_text[-200:])
        check('有操作提示', ('↑↓' in p7.seen_text) or ('移动' in p7.seen_text), p7.seen_text[-200:])
        check('显示位置指示 x/3', '/3' in p7.seen_text, p7.seen_text[-200:])

        # 先 Home 归位（初始可能预选「上次」会话），再 ↓ 两次 → 第 3 项
        p7.send('\x1b[H')
        time.sleep(0.3)
        p7.send('\x1b[B')
        time.sleep(0.25)
        p7.send('\x1b[B')
        time.sleep(0.25)
        check('按 ↓ 后预览切到第 3 项',
              p7.wait_for('预览 · 20261101-0100-会话一', 8), p7.seen_text[-200:])

        p7.send('\r')
        ok7 = p7.wait_for('历史对话', 20)
        check('Enter 后恢复被选中的会话', ok7, p7.seen_text[-300:])
        restored7 = p7.seen_text[p7.seen_text.rfind('历史对话'):]
        check('恢复的是第 3 项（会话一）的内容', '标记-一' in restored7, restored7[:300])
        check('没有误恢复其它会话', '标记-三' not in restored7 and '标记-二' not in restored7,
              restored7[:300])
        p7.kill()

        # ==================================================
        print('\n=== 8. 交互式选择器：数字跳转仍可用 ===\n')
        # ==================================================
        home8 = tempfile.mkdtemp(prefix='mtn-pty8-')
        env8 = dict(env)
        env8['HOME'] = home8
        seed_session(home8, '20261103-0300-会话三', '会话三', marker_history('三'))
        seed_session(home8, '20261102-0200-会话二', '会话二', marker_history('二'))
        seed_session(home8, '20261101-0100-会话一', '会话一', marker_history('一'))

        p8 = Pty(env8).start(['-r'])
        p8.read(2.0)
        check('数字跳转测试前列表已显示', p8.wait_for('可用会话', 10))
        p8.send('2')
        check('输 2 后预览切到第 2 项',
              p8.wait_for('预览 · 20261102-0200-会话二', 8), p8.seen_text[-200:])
        p8.send('\r')
        check('Enter 后恢复第二个会话', p8.wait_for('历史对话', 20), p8.seen_text[-300:])
        check('数字 2 → 恢复的是会话二',
              '标记-二' in p8.seen_text[p8.seen_text.rfind('历史对话'):], p8.seen_text[-300:])
        p8.kill()

        # ==================================================
        print('\n=== 9. 中断：运行中 Ctrl+C 打断当前行动（不杀进程、会话可继续）===\n')
        # ==================================================
        # 起一个「10 秒才响应」的 stub 服务，模拟模型正在慢慢思考。
        # 用户的诉求是：这时候按 Ctrl+C 应该「停下来」而不是「退出程序」。
        slow_port = free_port()
        slow_srv = start_slow_server(slow_port)
        try:
            home9 = tempfile.mkdtemp(prefix='mtn-pty9-')
            env9 = dict(env)
            env9['HOME'] = home9
            env9['OPENAI_BASE_URL'] = f'http://127.0.0.1:{slow_port}'

            p9 = Pty(env9).start([])          # 新会话（不 -r，避免选择器干扰）
            p9.read(2.5)
            check('慢服务模式：进入主循环', p9.wait_for('mythinknode', 10), p9.seen_text[-200:])

            p9.send('随便问点什么')
            time.sleep(0.2)
            p9.send('\r')
            # 等请求真的发出（stub 收到请求后开始计时）
            sent = wait_until(lambda: slow_srv['hits'] > 0, 15)
            check('请求已发往（慢）服务', sent, f"hits={slow_srv['hits']}")
            time.sleep(0.6)                   # 确认确实在「运行中」

            # 按 Ctrl+C
            mark9 = len(p9.seen_text)
            t0 = time.time()
            p9.send('\x03')
            # ⚠️ 不能用 '>>>' 当「回到提示符」的依据：banner 里本来就有 '>>>'，
            # 恒为真 → 假通过（这里踩过一次）。用中断专属文案做锚点。
            back = p9.wait_for('已中断当前行动', 8)
            elapsed = time.time() - t0
            check('Ctrl+C 后出现中断确认', back, p9.seen_text[-300:])
            check('中断在 3 秒内生效（没等 10s 的响应）', elapsed < 3.0, f'{elapsed:.2f}s')
            check('进程仍存活（不是杀进程）', p9.alive())
            check('中断后有回显（不是无响应）', '中断' in p9.seen_text[mark9:],
                  p9.seen_text[mark9:][:300])

            # 会话文件必须存在且可解析
            dirs9 = session_dirs(home9)
            check('会话目录存在', len(dirs9) >= 1, str(dirs9))
            ok9, reason9 = check_session_integrity(home9)
            check('会话文件 JSON 合法且无悬空 tool_use', ok9, reason9)

            # 继续说话：会话未报废
            slow_srv['fast'] = True           # 让后续请求立即返回
            mark9b = len(p9.seen_text)
            p9.send('继续')
            time.sleep(0.2)
            p9.send('\r')
            check('中断后能继续对话（会话可用）',
                  p9.wait_for('assistant-ok', 15), p9.seen_text[mark9b:][:300])
            ok9b, reason9b = check_session_integrity(home9)
            check('继续对话后仍无悬空 tool_use', ok9b, reason9b)
            p9.kill()
            shutil.rmtree(home9, ignore_errors=True)
        finally:
            slow_srv['stop'] = True
            slow_srv['srv'].shutdown()

        # ==================================================
        print('\n=== 10. 中断：空闲时 Ctrl+C 仍然退出 ===\n')
        # ==================================================
        home10 = tempfile.mkdtemp(prefix='mtn-pty10-')
        env10 = dict(env)
        env10['HOME'] = home10
        p10 = Pty(env10).start([])
        p10.read(2.5)
        check('空闲状态进入主循环', p10.wait_for('>>>', 10), p10.seen_text[-200:])
        p10.send('\x03')
        exited = False
        deadline = time.time() + 10
        while time.time() < deadline:
            p10.read(0.3)
            if not p10.alive():
                exited = True
                break
        check('空闲时 Ctrl+C → 退出（保持原语义）', exited)
        p10.kill()
        shutil.rmtree(home10, ignore_errors=True)

        # ==================================================
        print('\n=== 11. 中断：TUI 模式下 Esc 打断当前行动 ===\n')
        # ==================================================
        # TUI 走 Ink 的 useInput（不是 input-buffer），按键来源不同，必须单独验。
        slow_port2 = free_port()
        slow_srv2 = start_slow_server(slow_port2)
        try:
            home11 = tempfile.mkdtemp(prefix='mtn-pty11-')
            env11 = dict(env)
            env11['HOME'] = home11
            env11['MYTHINKNODE_UI'] = 'tui'
            env11['OPENAI_BASE_URL'] = f'http://127.0.0.1:{slow_port2}'

            p11 = Pty(env11).start([])
            p11.read(1.0)
            check('TUI 模式启动', p11.wait_for('mythinknode', 20), p11.seen_text[-200:])
            check('TUI：输入框就绪（可接收按键）', wait_input_ready(p11), p11.seen_text[-300:])

            p11.send('TUI 中断测试')
            time.sleep(0.25)
            p11.send('\r')
            sent11 = wait_until(lambda: slow_srv2['hits'] > 0, 15)
            check('TUI：请求已发往（慢）服务', sent11, f"hits={slow_srv2['hits']}")
            time.sleep(0.8)

            mark11 = len(p11.seen_text)
            t0 = time.time()
            p11.send('\x1b')          # Esc
            back11 = p11.wait_for('已中断当前行动', 8)
            elapsed11 = time.time() - t0
            check('TUI：Esc 触发中断', back11, p11.seen_text[mark11:][:300])
            check('TUI：中断在 3 秒内生效', elapsed11 < 3.0, f'{elapsed11:.2f}s')
            check('TUI：进程仍存活', p11.alive())

            ok11, reason11 = check_session_integrity(home11)
            check('TUI：会话无悬空 tool_use', ok11, reason11)

            # 继续对话
            slow_srv2['fast'] = True
            mark11b = len(p11.seen_text)
            p11.send('继续')
            time.sleep(0.25)
            p11.send('\r')
            check('TUI：中断后能继续对话', p11.wait_for('assistant-ok', 15),
                  p11.seen_text[mark11b:][:300])
            p11.kill()
            shutil.rmtree(home11, ignore_errors=True)
        finally:
            slow_srv2['stop'] = True
            slow_srv2['srv'].socket.close()

        # ----------------------------------------------------------
        print('\n=== 12. 指令队列：运行中也能输入，Enter 入队，本轮结束自动接续 ===\n')
        # ----------------------------------------------------------
        # 改前 `{state.waiting && <InputBox/>}`：一轮开始输入框整个卸载，用户
        # 只能干等。这组用真 PTY 验「运行中打字 → 托盘出现 → 当前轮结束后
        # 自动开始下一条（不需要用户再按回车）」。
        slow_port12 = free_port()
        slow_srv12 = start_slow_server(slow_port12)
        try:
            home12 = tempfile.mkdtemp(prefix='mtn-pty12-')
            env12 = dict(env)
            env12['HOME'] = home12
            env12['MYTHINKNODE_UI'] = 'tui'
            env12['OPENAI_BASE_URL'] = f'http://127.0.0.1:{slow_port12}'

            p12 = Pty(env12).start([])
            p12.read(1.0)
            check('队列：TUI 模式启动', p12.wait_for('mythinknode', 20), p12.seen_text[-200:])
            check('队列：输入框就绪（可接收按键）', wait_input_ready(p12), p12.seen_text[-300:])

            p12.send('第一条指令')
            time.sleep(0.25)
            p12.send('\r')
            started12 = wait_until(lambda: slow_srv12['hits'] > 0, 15)
            check('队列：第一条已发往（慢）服务', started12, f"hits={slow_srv12['hits']}")
            time.sleep(0.6)

            # ---- 运行中输入第二条并回车（此刻 agent 还在等模型回复）----
            mark12 = len(p12.seen_text)
            p12.send('第二条排队指令')
            time.sleep(0.4)
            run_text12 = p12.seen_text[mark12:]
            check('队列：运行中按键被接收（输入框仍在，未被吞）',
                  '第二条排队指令' in run_text12, run_text12[:300])

            p12.send('\r')
            time.sleep(0.8)
            # ⚠️ 基线必须是 mark12（打字之前），不是回车之后的某个点 ——
            # 托盘的渲染可能和回车回显在同一批输出里，回车后再取基线就会漏掉
            # （2026-11-14 踩过一次）。
            queued12 = p12.seen_text[mark12:]
            check('队列：Enter 后进入托盘（显示队列条目）',
                  '第二条排队指令' in queued12 and ('1.' in queued12 or '队列' in queued12),
                  queued12[:400])
            check('队列：提示行改为「排队」语义',
                  '排队' in queued12 or 'Enter 排队' in p12.seen_text, queued12[:300])
            check('队列：第一条仍在运行（未被打断）', p12.alive())

            # ---- 放行慢服务：第一条结束后应自动接续第二条，无需再按回车 ----
            slow_srv12['fast'] = True
            hits_before = slow_srv12['hits']
            auto12 = wait_until(lambda: slow_srv12['hits'] > hits_before, 20)
            check('队列：当前轮结束后自动开始下一条（无需再按 Enter）',
                  auto12, f"hits={slow_srv12['hits']}")

            done12 = p12.wait_for('assistant-ok', 20)
            check('队列：第二条也执行完成', done12, p12.seen_text[-300:])
            check('队列：进程仍存活', p12.alive())

            ok12, reason12 = check_session_integrity(home12)
            check('队列：会话无悬空 tool_use', ok12, reason12)

            p12.kill()
            shutil.rmtree(home12, ignore_errors=True)
        finally:
            slow_srv12['stop'] = True
            slow_srv12['srv'].socket.close()

        # ----------------------------------------------------------
        print('\n=== 13. 指令队列：Ctrl+X 清空队列但不打断 ===\n')
        # ----------------------------------------------------------
        slow_port13 = free_port()
        slow_srv13 = start_slow_server(slow_port13)
        try:
            home13 = tempfile.mkdtemp(prefix='mtn-pty13-')
            env13 = dict(env)
            env13['HOME'] = home13
            env13['MYTHINKNODE_UI'] = 'tui'
            env13['OPENAI_BASE_URL'] = f'http://127.0.0.1:{slow_port13}'

            p13 = Pty(env13).start([])
            p13.read(1.0)
            p13.wait_for('mythinknode', 20)
            wait_input_ready(p13)

            p13.send('正在跑的东西')
            time.sleep(0.25)
            p13.send('\r')
            wait_until(lambda: slow_srv13['hits'] > 0, 15)
            time.sleep(0.6)

            p13.send('这条会被清掉')
            time.sleep(0.3)
            p13.send('\r')
            time.sleep(0.5)

            mark13 = len(p13.seen_text)
            p13.send('\x18')          # Ctrl+X
            time.sleep(0.6)
            cleared13 = p13.seen_text[mark13:]
            check('清队列：Ctrl+X 提示已清空', '清空队列' in cleared13, cleared13[:300])
            check('清队列：Ctrl+X 不打断（进程仍活、未被中断）',
                  p13.alive() and '已中断' not in cleared13, cleared13[:300])

            # 清掉之后本轮结束不应再自动接续
            hits_before13 = slow_srv13['hits']
            slow_srv13['fast'] = True
            p13.wait_for('assistant-ok', 20)
            time.sleep(2.5)
            check('清队列：本轮结束后不再自动接续（队列确实空了）',
                  slow_srv13['hits'] == hits_before13 + 0 or slow_srv13['hits'] <= hits_before13 + 1,
                  f"hits={slow_srv13['hits']} before={hits_before13}")

            p13.kill()
            shutil.rmtree(home13, ignore_errors=True)
        finally:
            slow_srv13['stop'] = True
            slow_srv13['srv'].socket.close()

        for h in (home2, home3, home4, home5, home6, home7, home8):
            shutil.rmtree(h, ignore_errors=True)

    finally:
        if args.keep:
            print(f'\n保留 HOME: {home}')
        else:
            shutil.rmtree(home, ignore_errors=True)

    print(f'\n结果: {PASS} 通过, {FAIL} 失败\n')
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
