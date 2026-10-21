#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
极简 Chrome DevTools Protocol (CDP) 客户端 —— 纯标准库

为什么需要它
------------
现代 Chrome/Edge（≥127）对磁盘上的 Cookie 启用了 **App-Bound Encryption (v20)**，
任何外部进程都无法用 DPAPI 解开——这是设计上的防护，不是可以绕过的 bug。

但**浏览器自己**能读自己的 Cookie。CDP 的 `Network.getCookies` 就能拿到
（含 HttpOnly），这是官方调试协议，不是绕过安全边界。

⚠️ 前提：Chrome 136+ 出于安全考虑，**拒绝在默认用户配置上开启远程调试**。
所以只能用于我们自己创建的专用配置目录（`browser_visit.profile_dir()`）。
本模块读不到用户日常浏览器的 Cookie——那是被有意封死的。

能力
----
    launch(profile, url)         启动带调试端口的浏览器（端口自选）
    get_cookies(port, urls)      读取指定站点的 Cookie（含 HttpOnly）
    evaluate(port, expr)         在页面里执行 JS（可用于点击按钮）
    capture(spec)                ★ 打开可见浏览器 → 等登录 → 采 Cookie → 写凭证

用法
----
    python cdp.py --capture lingxi     # 采集 WPS 灵犀凭证（免手工复制）
    python cdp.py --capture jimeng     # 采集即梦凭证
    python cdp.py --selftest <profile_dir> <url>   # 通路自测
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))

try:
    from . import browser_visit as bv
except ImportError:
    import browser_visit as bv


# 本机调试端口必须绕过环境代理。
# 踩过的坑：环境里设了 HTTP_PROXY 时，urllib 会把 http://127.0.0.1:PORT 也走代理，
# 结果拿到 502 Bad Gateway，看起来像"端口没起来"，实际是被代理吞了。
_LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _local_get(url: str, timeout: float = 3.0) -> bytes:
    with _LOCAL_OPENER.open(url, timeout=timeout) as resp:
        return resp.read()


# --------------------------------------------------------------------------
# 极简 WebSocket 客户端（RFC 6455，仅实现 CDP 需要的部分）
# --------------------------------------------------------------------------
class WebSocket:
    """只支持：客户端掩码文本帧、服务端文本帧、分片累积。够 CDP 用。"""

    def __init__(self, url: str, timeout: float = 20.0):
        # url 形如 ws://127.0.0.1:9222/devtools/page/XXXX
        assert url.startswith("ws://"), f"仅支持 ws://，收到 {url[:20]}"
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        self.sock.settimeout(timeout)
        self._handshake(host, int(port or 80), "/" + path)

    def _handshake(self, host, port, path):
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("WebSocket 握手被关闭")
            buf += chunk
        head = buf.split(b"\r\n\r\n", 1)[0].decode("latin1")
        if "101" not in head.split("\r\n")[0]:
            raise ConnectionError(f"WebSocket 握手失败：{head.splitlines()[0]}")
        expect = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode()
        if expect.lower() not in head.lower():
            raise ConnectionError("WebSocket 握手校验失败（Sec-WebSocket-Accept 不匹配）")

    def send_text(self, text: str):
        payload = text.encode("utf-8")
        header = bytearray([0x81])                      # FIN + opcode=1(text)
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)                     # 客户端必须掩码
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _recv_exact(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("连接被关闭")
            buf += chunk
        return buf

    def recv_text(self) -> str:
        """读一条完整的文本消息（自动处理分片与 ping）。"""
        chunks = []
        while True:
            b0, b1 = self._recv_exact(2)
            fin = b0 & 0x80
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if masked else None
            payload = self._recv_exact(length) if length else b""
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

            if opcode == 0x9:                           # ping → pong
                self.sock.sendall(b"\x8a\x80" + os.urandom(4))
                continue
            if opcode == 0x8:                           # close
                raise ConnectionError("服务端关闭了连接")
            if opcode in (0x1, 0x0):
                chunks.append(payload)
                if fin:
                    return b"".join(chunks).decode("utf-8", "replace")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# --------------------------------------------------------------------------
# CDP 会话
# --------------------------------------------------------------------------
class CDP:
    def __init__(self, ws_url: str):
        self.ws = WebSocket(ws_url)
        self._id = 0

    def call(self, method: str, params: dict | None = None, timeout: float = 25.0):
        """发一条命令并等待其 id 对应的响应（跳过事件通知）。"""
        self._id += 1
        mid = self._id
        self.ws.send_text(json.dumps({"id": mid, "method": method,
                                      "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(self.ws.recv_text())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"CDP 错误：{msg['error']}")
                return msg.get("result", {})
        raise TimeoutError(f"CDP 命令超时：{method}")

    def close(self):
        self.ws.close()


# --------------------------------------------------------------------------
# 启动与连接
# --------------------------------------------------------------------------
def _clear_active_port(profile: str) -> None:
    p = os.path.join(profile, "DevToolsActivePort")
    if os.path.isfile(p):
        try:
            os.remove(p)
        except OSError:
            pass


def read_active_port(profile: str, timeout: float = 30.0) -> int:
    """从配置目录的 DevToolsActivePort 文件回读浏览器实际选用的调试端口。

    为什么不让浏览器用固定端口：踩过的坑——固定端口 9333 在本机被占用/保留，
    表现为「端口拒绝连接」，排查很久才定位到是端口冲突而不是权限或参数问题。
    传 `--remote-debugging-port=0` 让浏览器自选空闲端口，从根上避免这类问题。
    """
    p = os.path.join(profile, "DevToolsActivePort")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.isfile(p):
            try:
                first = open(p, encoding="utf-8").read().splitlines()[0].strip()
                if first.isdigit() and int(first) > 0:
                    return int(first)
            except (OSError, IndexError):
                pass
        time.sleep(0.3)
    raise TimeoutError(
        f"未能从 {p} 读到调试端口（浏览器可能未成功启动或该文件被占用）")


def launch(profile: str, url: str = "about:blank", headless: bool = True,
           timeout: float = 30.0):
    """启动带调试端口的浏览器。

    返回 (进程, 实际端口)。端口由浏览器自选（避免冲突）。

    ⚠️ 必须传绝对路径的 profile：踩过的坑——传相对路径时，Edge 的启动器
    （`Application\\msedge.exe` 只是个 loader）会把工作目录切到自己的安装目录，
    于是 `--user-data-dir=相对路径` 落到了别处（且因无写权限而静默失败），
    表现为「`DevToolsActivePort` 永远不出现」。这里强制转绝对路径兜底。
    """
    profile = os.path.abspath(profile)
    _clear_active_port(profile)
    exe = bv.find_browser()
    args = [exe, f"--user-data-dir={profile}",
            "--remote-debugging-port=0",          # 0 = 自选空闲端口
            "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", "--disable-background-networking",
            "--disable-sync"]
    if headless:
        args += ["--headless=new", "--disable-gpu"]
    args.append(url)
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    port = read_active_port(profile, timeout=timeout)
    wait_endpoint(port, timeout=timeout)
    return proc, port


def wait_endpoint(port: int, timeout: float = 30.0) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            return json.loads(_local_get(f"http://127.0.0.1:{port}/json/version").decode())
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5)
    raise TimeoutError(f"调试端口 {port} 在 {timeout}s 内未就绪（最后错误：{last}）")


def find_page_ws(port: int, timeout: float = 15.0) -> str:
    """找一个 page 类型目标的 WebSocket 地址。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            targets = json.loads(_local_get(f"http://127.0.0.1:{port}/json/list").decode())
            for t in targets:
                if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                    return t["webSocketDebuggerUrl"]
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5)
    raise TimeoutError("未找到可用的 page 目标")


def get_cookies(port: int, urls: list[str]) -> list[dict]:
    """读取指定站点的 Cookie（含 HttpOnly）。"""
    cdp = CDP(find_page_ws(port))
    try:
        res = cdp.call("Network.getCookies", {"urls": urls})
        return res.get("cookies", [])
    finally:
        cdp.close()


def evaluate(port: int, expr: str, await_promise: bool = True):
    """在页面里执行 JS 并返回结果。"""
    cdp = CDP(find_page_ws(port))
    try:
        res = cdp.call("Runtime.evaluate",
                       {"expression": expr, "awaitPromise": await_promise,
                        "returnByValue": True})
        return res.get("result", {}).get("value")
    finally:
        cdp.close()


def to_cookie_header(cookies: list[dict], only_hosts: list[str] | None = None) -> str:
    """把 CDP cookie 列表拼成 Cookie 请求头。"""
    parts = []
    for c in cookies:
        if only_hosts and not any(h in c.get("domain", "") for h in only_hosts):
            continue
        parts.append(f"{c['name']}={c['value']}")
    return "; ".join(parts)


# --------------------------------------------------------------------------
# 凭证采集：让用户只需「登录一次」，不再手工复制 Cookie
# --------------------------------------------------------------------------
def _load_adapter(modname: str):
    """按文件路径加载同目录的适配器模块。

    踩过的坑：PyPI 上存在名为 `jimeng` 的包，直接 `import jimeng` 会加载到它
    而不是本目录的 jimeng.py，报 `AttributeError: module 'jimeng' has no attribute ...`。
    按绝对路径加载可绕开 sys.path 歧义。
    """
    import importlib.util

    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)          # 适配器内部的 `import cookie_util` 依赖它
    path = os.path.join(here, f"{modname}.py")
    if not os.path.isfile(path):
        raise SystemExit(f"未找到适配器模块：{path}")
    spec = importlib.util.spec_from_file_location(f"_signin_{modname}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# 平台别名 → 适配器模块名
_PRESET_ALIASES = {
    "lingxi": "lingxi", "wps": "lingxi", "灵犀": "lingxi", "wps灵犀": "lingxi",
    "jimeng": "jimeng", "即梦": "jimeng", "dreamina": "jimeng",
}


def load_spec(name: str) -> dict:
    """把平台名解析成采集规格。规格由各适配器的 capture_spec() 提供。"""
    key = _PRESET_ALIASES.get((name or "").strip().lower())
    if not key:
        raise SystemExit(
            f"未知平台：{name!r}\n"
            f"  可用：lingxi（WPS 灵犀） / jimeng（即梦）")
    return _load_adapter(key).capture_spec()


def _sanity_browser_cookie(header: str) -> tuple[bool, str]:
    """对浏览器采集来的 Cookie 做**结构**自检。

    ⚠️ 这里刻意**不做占位符检查**，这是有意的设计区分：
      - `cookie_util` 的占位符过滤是为「人工输入」设的防线——挡住
        「把 <模板文字> 当参数粘进来」这类错误。
      - 本函数的输入是浏览器真实吐出的值，程序化来源不存在「粘贴错误」，
        再做文本匹配只会引入**误杀**：例如 base64 值里恰好出现连续 `xxx`
        就会被占位符规则命中而误判。
    两种来源用两套判据，各管各的。
    """
    if not header or "=" not in header:
        return False, "采集到的 Cookie 为空或格式异常"
    return True, "结构正常"


def capture(spec: dict, *, wait: float = 300.0, poll: float = 3.0,
            headless: bool = False) -> int:
    """打开可见浏览器 → 等用户登录 → 采集 Cookie → 功能验证 → 写入凭证文件。

    为什么值得这么做：手工从 F12 里全选复制 Cookie 有两个坑——
      ① 核心会话是 HttpOnly，肉眼看不见，容易漏；
      ② 复制出来的格式（换行、截断）容易出错。
    CDP 直接向浏览器要，两条都自然规避。

    验证策略见 `spec["verify"]`：拿采集到的 Cookie 真去调接口，通了才算成功。
    """
    profile = os.path.abspath(bv.profile_dir(spec["profile"]))
    output = os.path.abspath(spec["output"])
    label = spec.get("label") or spec["profile"]
    url = spec["url"]
    host = spec.get("host_filter") or ""
    verify = spec.get("verify")

    print(f"平台：{label}")
    print(f"浏览器配置目录：{profile}")
    print(f"凭证写入位置：{output}")
    print(f"\n即将打开：{url}")
    print("请在弹窗里完成登录。登录成功后本程序会**自动识别并保存凭证**，")
    print("不需要手工复制 Cookie，也不需要手动关窗口。")
    print(f"最长等待 {int(wait)} 秒。\n")

    proc, port = launch(profile, url, headless=headless)
    cdp = None
    last = "尚未读到 Cookie"
    try:
        deadline = time.time() + wait
        attempt = 0
        while time.time() < deadline:
            attempt += 1
            try:
                if cdp is None:
                    cdp = CDP(find_page_ws(port))
                res = cdp.call("Network.getCookies", {"urls": [url]}, timeout=15)
                cookies = res.get("cookies", [])
            except Exception as exc:  # noqa: BLE001
                if cdp is not None:
                    cdp.close()
                    cdp = None
                last = f"读取 Cookie 失败：{type(exc).__name__}: {exc}"
                time.sleep(poll)
                continue

            scoped = [c for c in cookies
                      if not host or host in (c.get("domain") or "")]
            header = to_cookie_header(scoped)
            if not header:
                last = f"{host or '目标站点'} 下还没有 Cookie（尚未登录？）"
                time.sleep(poll)
                continue

            ok_struct, why = _sanity_browser_cookie(header)
            if not ok_struct:
                last = why
                time.sleep(poll)
                continue

            if verify is None:
                ok, msg = True, "未提供验证函数，按结构校验采信"
            else:
                try:
                    ok, msg = verify(header)
                except Exception as exc:  # noqa: BLE001
                    ok, msg = False, f"验证函数异常：{type(exc).__name__}: {exc}"

            if ok:
                os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
                with open(output, "w", encoding="utf-8") as fh:
                    fh.write(header)
                try:      # Windows 上为 no-op，POSIX 下收紧权限
                    os.chmod(output, 0o600)
                except OSError:
                    pass
                names = sorted({c["name"] for c in scoped})
                print(f"✅ 采集成功（第 {attempt} 次探测）")
                print(f"   验证：{msg}")
                print(f"   已写入：{output}")
                print(f"   共 {len(names)} 个字段（含 HttpOnly）：")
                print("   " + ", ".join(names[:14])
                      + (" …" if len(names) > 14 else ""))
                print("\n   该文件含登录凭据，请勿分享或提交到代码仓库。")
                return 0

            last = msg
            time.sleep(poll)

        print(f"❌ 超时（{int(wait)}s）仍未采集到可用凭证。最后状态：{last}")
        print("   常见原因：① 未完成登录；② 登录后跳到了别的域；")
        print("             ③ 该站点的会话字段不在此域名下（需调整 host_filter）")
        return 1
    finally:
        if cdp is not None:
            cdp.close()
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


# --------------------------------------------------------------------------
# 自测
# --------------------------------------------------------------------------
def _selftest(profile: str, url: str) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    profile = os.path.abspath(profile)
    print(f"配置目录：{profile}")
    print(f"目标站点：{url}\n")

    proc, port = launch(profile, url)
    try:
        ver = wait_endpoint(port)
        print(f"✅ 调试端口就绪：{ver.get('Browser')}（自选端口 {port}）")
        print(f"   协议版本：{ver.get('Protocol-Version')}")
        time.sleep(3)  # 给页面一点时间加载
        cookies = get_cookies(port, [url])
        print(f"\n✅ 读到 {len(cookies)} 个 Cookie（含 HttpOnly）：")
        for c in sorted(cookies, key=lambda x: x["name"])[:25]:
            flag = "🔒" if c.get("httpOnly") else "  "
            v = c["value"]
            print(f"   {flag} {c['name']:<32} {c['domain']:<20} "
                  f"值长度={len(v)}")
        header = to_cookie_header(cookies)
        print(f"\n拼成 Cookie 头长度：{len(header)}")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"❌ 失败：{type(exc).__name__}: {exc}")
        return 1
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


def main() -> int:
    argv = sys.argv[1:]
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if "--capture" in argv:
        i = argv.index("--capture")
        name = argv[i + 1] if i + 1 < len(argv) and not argv[i + 1].startswith("-") else ""
        if not name:
            print("用法：python cdp.py --capture <平台>")
            print("  平台：lingxi（WPS 灵犀） / jimeng（即梦）")
            return 2
        wait = 300.0
        for a in argv:
            if a.startswith("--wait="):
                wait = float(a.split("=", 1)[1])
        # --headless：不弹窗。仅在专用配置目录里登录态仍然有效时有意义
        # （例如凭证过期重采）；首次登录必须用有窗口模式。
        return capture(load_spec(name), wait=wait, headless="--headless" in argv)

    if "--selftest" in argv:
        i = argv.index("--selftest")
        profile = argv[i + 1] if i + 1 < len(argv) else bv.profile_dir("coze")
        url = argv[i + 2] if i + 2 < len(argv) else "https://www.coze.cn/"
        return _selftest(profile, url)

    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
