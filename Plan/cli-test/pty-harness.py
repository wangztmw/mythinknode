#!/usr/bin/env python3
"""
PTY 交互测试 harness —— 驱动真实终端里的 mythinknode CLI，
验证输入/输出层在「真实终端 + raw mode + 备用屏」下的端到端行为。

单元测试（*.mjs）只测纯逻辑（InputModel / CellGrid / ScreenBuffer / wrapLine）。
本 harness 补上它们覆盖不到的部分：
  - 进程真实启动、banner、prompt 渲染
  - raw mode + 自管 stdin 的字节级输入
  - 中文/emoji 双宽 echo、退格/方向键编辑
  - bracketed paste 多行粘贴
  - /help 命令、Ctrl+C 干净退出（终端状态无残留）
  - 超长单行（粘贴）不卡死
  - 终端 resize

用法：
  python3 Plan/cli-test/pty-harness.py [--scenario all|basic|cjk|edit|paste|help|longline|resize|exit]
"""

import os
import sys
import re
import time
import select
import struct
import fcntl
import termios
import signal
import argparse

PROJECT = os.path.expanduser("~/Desktop/CLit/my-coder")
ENTRY = os.path.join(PROJECT, "dist", "Mythinknode.js")

ANSI_RE = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]|\x1b\][^\x07]*\x07')


def strip_ansi(s: str) -> str:
    return ANSI_RE.sub('', s)


class PtySession:
    """forkpty 驱动的 CLI 会话。"""

    def __init__(self, rows=24, cols=80, timeout=5.0):
        self.rows = rows
        self.cols = cols
        self.timeout = timeout
        self.pid = None
        self.fd = None
        self.buf = b''

    def start(self):
        pid, fd = os.forkpty()
        if pid == 0:
            # 子进程：进入项目目录运行 CLI
            os.chdir(PROJECT)
            os.execvp("node", ["node", ENTRY])
        self.pid = pid
        self.fd = fd
        # 非阻塞读
        fl = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
        self._set_winsize(self.rows, self.cols)
        return self

    def _set_winsize(self, rows, cols):
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            self.rows, self.cols = rows, cols
        except OSError as e:
            print(f"  [warn] set_winsize failed: {e}")

    def send(self, data: bytes):
        os.write(self.fd, data)

    def send_text(self, s: str):
        self.send(s.encode('utf-8'))

    def key(self, seq: str):
        """发送转义键序列（如 '\\x1b[D' 左方向键）。"""
        self.send(seq.encode('latin-1', errors='replace'))

    def read_available(self, wait=0.3) -> bytes:
        """读当前可用输出，最多等 wait 秒。"""
        deadline = time.time() + wait
        while time.time() < deadline:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError:
                    return self._drain()
                if not chunk:
                    return self._drain()
                self.buf += chunk
        return self._drain()

    def _drain(self) -> bytes:
        while True:
            r, _, _ = select.select([self.fd], [], [], 0)
            if not r:
                break
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self.buf += chunk
        out = self.buf
        self.buf = b''
        return out

    def wait_for(self, needle: str, timeout=None):
        """等待输出中出现 needle（原始字节，可含 ANSI 间字符）。返回匹配文本与否。"""
        timeout = timeout or self.timeout
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.read_available(0.15)
            if needle.encode() in self.buf:
                return True
        return needle.encode() in self.buf

    def visible_text(self) -> str:
        """当前缓冲去掉 ANSI 后的可见文本（含换行）。"""
        return strip_ansi(self.buf.decode('utf-8', errors='replace'))

    def close(self):
        try:
            if self.pid:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
        except Exception:
            pass
        self.pid = None


# ---------------------------------------------------------------- 断言工具

PASS = []
FAIL = []


def check(name: str, cond: bool, detail=""):
    if cond:
        PASS.append(name)
        print(f"  ✅ {name}")
    else:
        FAIL.append(name)
        print(f"  ❌ {name}" + (f"  — {detail}" if detail else ""))


def summary():
    print(f"\n=== PTY 结果: {len(PASS)} 通过, {len(FAIL)} 失败 ===")
    return len(FAIL) == 0


# ---------------------------------------------------------------- 场景

def scenario_basic(sess: PtySession):
    """启动 + banner + prompt + ASCII 输入 echo。"""
    print("\n--- 基础启动 ---")
    sess.start()
    time.sleep(1.2)
    text = sess.visible_text()
    check("banner 出现", "mythinknode v0.6.0" in text, text[:200])
    check("prompt 出现 (>>>)", ">>>" in text, text[:200])

    sess.send_text("hello")
    time.sleep(0.4)
    check("ASCII echo (hello)", "hello" in sess.visible_text())
    sess.close()


def scenario_cjk(sess: PtySession):
    """中文/emoji 双宽 echo。"""
    print("\n--- 中文/emoji 输入 ---")
    sess.start()
    time.sleep(1.2)
    sess.send_text("你好世界")
    time.sleep(0.5)
    check("中文 echo (你好世界)", "你好世界" in sess.visible_text())
    sess.send_text(" 🚀测试")
    time.sleep(0.5)
    t = sess.visible_text()
    check("emoji+中文 echo", "🚀" in t and "测试" in t)
    sess.close()


def scenario_edit(sess: PtySession):
    """退格 / 方向键 / 插入。"""
    print("\n--- 编辑（退格/方向键/插入）---")
    sess.start()
    time.sleep(1.2)
    sess.send_text("abc")
    time.sleep(0.3)
    sess.key("\x1b[D")      # 左
    sess.key("\x1b[D")      # 左
    time.sleep(0.3)
    sess.send_text("X")     # 在 b 前插入 → aXbc
    time.sleep(0.3)
    check("中间插入 (aXbc)", "aXbc" in sess.visible_text())

    sess.key("\x1b[C")      # 右
    sess.send("\x7f")       # backspace
    time.sleep(0.3)
    # 光标在最右，退格删掉最后的 c → aXb
    check("退格删尾 (aXb)", "aXb" in sess.visible_text())
    sess.close()


def scenario_paste(sess: PtySession):
    """bracketed paste 多行。"""
    print("\n--- 多行粘贴（bracketed paste）---")
    sess.start()
    time.sleep(1.2)
    payload = "\x1b[200~line1\rline2\rline3\x1b[201~"
    sess.send_text(payload)
    time.sleep(0.5)
    t = sess.visible_text()
    check("粘贴多行 echo (line1)", "line1" in t)
    check("粘贴多行 echo (line2)", "line2" in t)
    check("粘贴多行 echo (line3)", "line3" in t)
    sess.close()


def scenario_help(sess: PtySession):
    """/help 命令。"""
    print("\n--- /help 命令 ---")
    sess.start()
    time.sleep(1.2)
    sess.send_text("/help\r")
    time.sleep(0.8)
    t = sess.visible_text()
    check("/help 显示 Tools:", "Tools:" in t, t[:300])
    check("/help 显示 Commands:", "Commands:" in t, t[:300])
    sess.close()


def scenario_longline(sess: PtySession):
    """超长单行粘贴不卡死。"""
    print("\n--- 超长单行（5万字）---")
    sess.start()
    time.sleep(1.2)
    payload = "中" * 50000
    t0 = time.time()
    sess.send_text(payload)
    # 等待 echo 完整（折行后 5 万字双宽，分帧到达）
    time.sleep(2.5)
    elapsed = time.time() - t0
    t = sess.visible_text()
    check("5万字 echo 完整", t.count("中") >= 40000, f"count={t.count('中')} elapsed={elapsed:.2f}s")
    sess.close()


def scenario_resize(sess: PtySession):
    """终端 resize 不崩。"""
    print("\n--- resize ---")
    sess.start()
    time.sleep(1.2)
    sess.send_text("resize test")
    time.sleep(0.4)
    sess._set_winsize(20, 40)
    time.sleep(0.8)
    sess._set_winsize(30, 120)
    time.sleep(0.8)
    t = sess.visible_text()
    check("resize 后进程仍活着（还有 prompt/banner）", ">>>" in t or "mythinknode" in t)
    sess.close()


def scenario_exit(sess: PtySession):
    """Ctrl+C 干净退出，无终端状态残留。"""
    print("\n--- Ctrl+C 退出 ---")
    sess.start()
    time.sleep(1.2)
    sess.send_text("abort me")
    time.sleep(0.3)
    sess.send("\x03")  # Ctrl+C
    time.sleep(0.6)
    t = sess.visible_text()
    check("退出打印 Bye.", "Bye." in t, t[:300])
    # 等子进程退出
    exited = False
    for _ in range(20):
        pid, st = os.waitpid(sess.pid, os.WNOHANG)
        if pid == sess.pid:
            exited = True
            break
        time.sleep(0.1)
    check("进程干净退出（exit code 0）", exited and os.WIFEXITED(st) and os.WEXITSTATUS(st) == 0,
          f"exited={exited} status={st if exited else 'N/A'}")
    sess.close()


SCENARIOS = {
    "all": None,
    "basic": scenario_basic,
    "cjk": scenario_cjk,
    "edit": scenario_edit,
    "paste": scenario_paste,
    "help": scenario_help,
    "longline": scenario_longline,
    "resize": scenario_resize,
    "exit": scenario_exit,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="all")
    ap.add_argument("--rows", type=int, default=24)
    ap.add_argument("--cols", type=int, default=80)
    args = ap.parse_args()

    if not os.path.exists(ENTRY):
        print(f"❌ 入口不存在: {ENTRY}（先 npm run build）")
        sys.exit(2)

    if args.scenario == "all":
        order = ["basic", "cjk", "edit", "paste", "help", "longline", "resize", "exit"]
        for name in order:
            sess = PtySession(args.rows, args.cols)
            SCENARIOS[name](sess)
    else:
        sess = PtySession(args.rows, args.cols)
        SCENARIOS[args.scenario](sess)

    sys.exit(0 if summary() else 1)


if __name__ == "__main__":
    main()
