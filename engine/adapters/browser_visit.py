#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
浏览器访问助手 —— 「打开页面即完成」类任务的通用实现

适用场景
--------
某些平台的每日福利**没有可直连的领取接口**，而是在**页面加载时**由前端自动调用。
这类平台只能靠「用已登录的浏览器打开一次页面」来完成。本模块把这套逻辑抽出来复用。

调用方式
--------
    from browser_visit import find_browser, profile_ready, login, visit, inspect

    login(PROFILE_DIR, SITE, "即梦")          # 首次：让用户登录一次
    visit(PROFILE_DIR, SITE, wait_seconds=45) # 之后每天：无头打开、等待、关闭

设计原则
--------
- **独立配置目录**：不碰用户日常浏览器的 Cookie 与登录态。
- **用完即关**：无头运行、不残留窗口。
- **不伪造身份**：用真实浏览器 + 真实登录态，不做指纹伪装。
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
SIGNIN_DIR = os.path.abspath(os.path.join(_HERE, ".."))

_EDGE_CANDIDATES = [
    os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
    os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
]


def find_browser() -> str:
    """定位浏览器可执行文件。可用环境变量 SIGNIN_BROWSER 覆盖。"""
    override = os.environ.get("SIGNIN_BROWSER")
    if override and os.path.isfile(override):
        return override
    for p in _EDGE_CANDIDATES:
        if p and os.path.isfile(p):
            return p
    raise FileNotFoundError(
        "未找到 Microsoft Edge。可用环境变量 SIGNIN_BROWSER 指定浏览器可执行文件路径")


def profile_dir(name: str) -> str:
    """返回某个平台专用配置目录的绝对路径（位于 AICheckin/ 下）。"""
    return os.path.join(SIGNIN_DIR, f".{name}_profile")


def profile_ready(path: str) -> bool:
    """配置目录是否已创建（**注意：这不等于已登录**）。

    浏览器一启动就会建 Cookies 库，所以本函数只能回答「跑没跑过 --login」。
    要判断是否真的登录，用 `login_status()`。
    """
    if not os.path.isdir(path):
        return False
    for _root, _dirs, files in os.walk(path):
        for f in files:
            if f.lower() in ("cookies", "cookies-journal"):
                return True
    return False


# --------------------------------------------------------------------------
# 登录态真校验
# --------------------------------------------------------------------------
# Edge/Chrome 的 Cookies 是一个 SQLite 库。库里的 `host_key` 与 `name` 字段是
# **明文**（只有 `encrypted_value` 用 DPAPI 加密），因此可以不解密就判断
# 「某站点下是否存在某些名字的 Cookie」——这足以验证登录是否真的发生。
_COOKIE_DB_REL = os.path.join("Default", "Network", "Cookies")


def site_cookies(path: str, host_like: str):
    """读取配置目录里某站点的 Cookie 名列表。

    返回 (cookie_names, note)：
      - 库不存在        → (None, 原因)
      - 库存在但无该站点 → ([], None)
      - 正常            → (名字列表, None)
    """
    db = os.path.join(path, _COOKIE_DB_REL)
    if not os.path.isfile(db):
        return None, "尚未创建浏览器配置目录（未执行过 --login）"

    tmp = None
    try:
        # 先复制再读：浏览器可能正占用该文件，直接开会失败
        fd, tmp = tempfile.mkstemp(suffix=".cookies.db")
        os.close(fd)
        shutil.copy2(db, tmp)
        con = sqlite3.connect(tmp)
        try:
            cur = con.execute(
                "SELECT name FROM cookies WHERE host_key LIKE ?",
                (f"%{host_like}%",))
            return sorted({n for (n,) in cur.fetchall()}), None
        finally:
            con.close()
    except Exception as exc:  # noqa: BLE001
        return None, f"读取 Cookies 库失败：{type(exc).__name__}: {exc}"
    finally:
        if tmp and os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def login_status(path: str, host_like: str,
                 key_names: tuple[str, ...] = ()) -> tuple[bool, str]:
    """判断是否真的登录了目标站点。返回 (是否登录, 说明)。"""
    names, note = site_cookies(path, host_like)
    if names is None:
        return False, note or "无法读取 Cookie"
    if not names:
        return False, (f"配置目录里没有 {host_like} 的 Cookie —— "
                       f"可能未登录，或登录后未产生 Cookie")
    if key_names:
        hit = [k for k in key_names if k in names]
        if not hit:
            return False, (f"有 {host_like} 的 {len(names)} 个 Cookie，"
                           f"但未见登录态字段（期望含 {' / '.join(key_names)}）")
        return True, f"已登录（命中 {' / '.join(hit)}，共 {len(names)} 个 Cookie）"
    return True, f"存在 {len(names)} 个 Cookie"


def _base_args(path: str) -> list[str]:
    return [
        f"--user-data-dir={path}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
    ]


def login(path: str, site: str, label: str) -> int:
    """打开可见窗口，供用户登录一次。"""
    exe = find_browser()
    print(f"浏览器：{exe}")
    print(f"配置目录：{path}")
    print(f"即将打开 {site}")
    print(f"\n请在打开的窗口里完成 {label} 登录。")
    print("登录成功、能看到首页后，直接关闭该浏览器窗口即可。\n")
    proc = subprocess.Popen([exe, *_base_args(path), site])
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
    print("已关闭。之后可直接运行签到入口。")
    return 0


def visit(path: str, site: str, wait_seconds: int = 45,
          headless: bool = True) -> dict:
    """无头打开页面、等待页面自身完成领取、然后关闭。"""
    exe = find_browser()
    args = [exe, *_base_args(path)]
    if headless:
        args += ["--headless=new", "--disable-gpu"]
    args.append(site)

    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    try:
        time.sleep(wait_seconds)
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()

    return {"mode": "headless" if headless else "visible",
            "waited": wait_seconds, "profile": path}


def inspect(path: str, host_like: str = "",
            key_names: tuple[str, ...] = ()) -> int:
    """打印浏览器与配置目录状态（只读）。"""
    print("浏览器路径：", end="")
    try:
        print(find_browser())
    except FileNotFoundError as exc:
        print("未找到 ——", exc)
    print("专用配置目录：", path)
    print("目录已创建：", os.path.isdir(path))
    if host_like:
        ok, why = login_status(path, host_like, key_names)
        print(f"登录态（{host_like}）：", ("✅ " if ok else "❌ ") + why)
    else:
        print("目录内已有数据：", profile_ready(path))
    return 0


def main(argv: list[str]) -> int:
    """命令行直用（一般由各平台适配器调用，不直接暴露）。"""
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
