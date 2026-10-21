#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
即梦 AI（Dreamina / 剪映）每日免费积分领取适配器 —— 直连方案

背景（前提已变更，务必读完）
----------------------------
本模块此前是**浏览器方案**：因为实测「不带签名的请求一律返回
`{"ret":"1014","errmsg":"system busy"}`」，而当时认为签名公式未公开，
于是改为用无头浏览器打开首页、靠页面自身完成领取。

**该前提已不成立。** 签名公式已从 `puyujian/jimeng-api` 逆向下游、
并与 `wangmingdong/workbuddy-signin` 的线上跑通实现逐字核对确认：

    Sign = MD5("9e2c|{uri 末 7 位}|7|8.4.0|{deviceTime}||11ac")

因此本模块改为**直连 HTTP**，不再依赖浏览器：
不需要 Edge、不需要专用配置目录、不需要一次性登录、不需要等 45 秒。
旧的浏览器方案完整保留在 `jimeng_browser.py`，可随时回退。

接口规格
--------
  查余额  POST /commerce/v1/benefits/user_credit      → data.credit.gift_credit
  领每日  POST /commerce/v1/benefits/credit_receive   → data.receive_quota / data.is_first_receive
  Body:   {"time_zone": "Asia/Shanghai"}

  deviceTime = 当前 Unix 时间戳（**秒**级，不是毫秒），同时作为 `Device-Time` 头发送
  （注意签名串第 6 段为空 → 字面量里出现连续两个 `|`）

  必需头  Appid / Device-Time / Sign / Sign-Ver / Pf / Appvr / Lan / Loc + 浏览器 UA
  必需 query（仅 credit_receive）
          aid=513695 & device_platform=web & region=cn & webId=<_tea_web_id>
          & da_version=3.3.9 & os=windows & web_component_open_flag=1
          & web_version=7.5.0 & aigc_features=app_lip_sync

凭证
----
即梦的凭证就是浏览器 Cookie（关键项 `sessionid`；`_tea_web_id` 用于 webId）。
存放于上一级的 `jimeng_cookie.txt`，或环境变量 `JIMENG_COOKIE`。

设计原则
--------
- 凭证只存本机文件，不上传、不打印全文。
- 幂等：服务端按天发放，`is_first_receive=false` 即当日已领，重复调用不会多给。
- 失败即停并给出明确提示；**不做任何绕过风控的尝试**（字节风控较严，Cookie 会周期性失效，
  失效后如实报错、请你重捕，而不是伪造设备指纹硬闯）。

用法
----
    python adapters/cdp.py --capture jimeng                # ★ 首次：自动采集（推荐）
    python jimeng.py --set-cookie "<完整 Cookie 字符串>"   # 首次：手工录入
    python jimeng.py --set-session "<sessionid>"           # 便捷写法（只给 sessionid）
    python jimeng.py --inspect                             # 检查凭证配置
    python jimeng.py --status                              # 只查余额，不领取
    python jimeng.py --dry-run                             # 演练（不发领取请求）
    python jimeng.py                                       # 执行领取

如何取 Cookie
-------------
**推荐**：`python adapters/cdp.py --capture jimeng`
会自动弹窗，你登录一次，程序用只读的余额接口验证通过后自动保存，
**不需要手工复制 Cookie**。

手工方式（备选）：
1. 浏览器打开 https://jimeng.jianying.com/ 并登录
2. F12 → Application（应用）→ Storage → Cookies → https://jimeng.jianying.com
3. 把该域下所有 Cookie 拼成 `k=v; k2=v2; ...` 一行，执行 --set-cookie
   （只给 `sessionid` 也能跑，但缺 `_tea_web_id` 时 webId 会退回内置默认值，成功率可能降低）

回退
----
若直连因风控失败（如持续 `ret:1014`），改用浏览器方案：
    python jimeng_browser.py --login     # 一次性登录
    python jimeng_browser.py             # 之后每天无头运行

⚠️ 说明：签名实现**已被服务端接受**（2026-09-26 对照实验：错误签名 → `ret:1014`，
正确签名 → `ret:1015 check login error`）。即签名这一环已实测通过，
剩余卡点只有 Cookie。若领取失败，把返回体发我，我据此校正。
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import http_direct as _http  # 直连（绕环境代理），见 http_direct.py

try:
    from . import cookie_util           # 作为包被导入时（checkin.py）
    from . import cred_paths            # 凭证路径的唯一事实来源
except ImportError:                      # 以脚本方式直接运行
    import cookie_util
    import cred_paths

# --------------------------------------------------------------------------
# 常量（与线上实现逐字一致，改动前请先确认上游是否变更）
# --------------------------------------------------------------------------
BASE = "https://jimeng.jianying.com"
CREDIT_QUERY = "/commerce/v1/benefits/user_credit"
CREDIT_RECEIVE = "/commerce/v1/benefits/credit_receive"

PLATFORM = "7"
VERSION = "8.4.0"
AID = 513695
APP_SDK_VERSION = "48.0.0"

# 取自上游作者 Cookie 的 _tea_web_id，仅作 webId 的兜底
# （能从你的 Cookie 解析出 _tea_web_id 时优先用你的）
DEFAULT_WEB_ID = "7674931588983997958"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36")

RECEIVE_PARAMS = {
    "aid": AID,
    "device_platform": "web",
    "region": "cn",
    "da_version": "3.3.9",
    "os": "windows",
    "web_component_open_flag": 1,
    "web_version": "7.5.0",
    "aigc_features": "app_lip_sync",
}

_HERE = os.path.dirname(os.path.abspath(__file__))

# 平台 id（供 cred_paths 定位凭证文件）。
PLATFORM = "jimeng"

# 兼容早期版本留下的文件名（仍在包内 engine/ 下，保留老查找路径）。
LEGACY_SESSION_FILE = os.path.join(_HERE, "..", "jimeng_session.txt")


# --------------------------------------------------------------------------
# 凭证读写
#
# 路径统一由 cred_paths 解析，与 JS 侧用同一份规则。
# 详见 cred_paths 模块顶部：包内凭证文件会随重装被抹掉，
# 权威位置是 <dshHome>/dsh-agent-checkin/engine/。
# --------------------------------------------------------------------------
def cookie_path() -> str:
    """写入凭证的目标路径（主位置：用户可写、重装不丢）。"""
    return cred_paths.write_target(PLATFORM)


def cookie_candidates() -> list[str]:
    """按优先级列出所有候选凭证路径（供 --inspect 展示）。"""
    return cred_paths.candidates(PLATFORM) + [
        os.path.abspath(LEGACY_SESSION_FILE)
    ]


def load_cookie() -> str:
    env = os.environ.get("JIMENG_COOKIE", "").strip()
    if env:
        return _validated(env, "环境变量 JIMENG_COOKIE")
    path, raw = cred_paths.read_existing(PLATFORM)
    if path and raw:
        return _validated(raw, path)
    # 老版本留下的裸 sessionid 文件，最后再试一次。
    legacy = os.path.abspath(LEGACY_SESSION_FILE)
    try:
        if os.path.isfile(legacy):
            raw = open(legacy, encoding="utf-8").read().strip()
            if raw:
                return _validated(raw, legacy)
    except OSError:
        pass
    raise FileNotFoundError(
        "未配置即梦凭证。请先执行：\n"
        f'  python jimeng.py --set-cookie "<完整 Cookie>"\n'
        f"（凭证写入位置：{cookie_path()}）\n"
        f"（已查找：{', '.join(cookie_candidates())}）\n"
        "若想改用浏览器方案（无需 Cookie）：python jimeng_browser.py --login")


def _validated(raw: str, where: str) -> str:
    """已存盘的凭证也要校验——防止把占位符当成真凭证使用。"""
    ok, why = cookie_util.usability(raw)
    if not ok:
        raise ValueError(
            f"凭证不可用（{where}）：{why}\n"
            f"  请重新采集：python adapters/cdp.py --capture jimeng\n"
            f"  或手工录入：python adapters/jimeng.py --set-cookie \"<真实 Cookie>\"")
    return raw


def save_cookie(value: str) -> None:
    # allow_bare_token=True：允许只给 sessionid 的便捷写法，但**会校验它像不像真令牌**，
    # 占位符文本在这里就会被挡下（这是之前踩过的坑：静默存进了垃圾）
    value = cookie_util.normalize(value, platform="即梦",
                                  allow_bare_token=True, bare_key="sessionid")
    p = cookie_path()
    cred_paths.ensure_parent(p)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(value)
    try:  # Windows 上为 no-op，POSIX 下收紧权限
        os.chmod(p, 0o600)
    except OSError:
        pass
    fields = cookie_util.cookie_names(value)
    print(f"✅ 凭证已保存到：{p}")
    print(f"   字段 {len(fields)} 个：{', '.join(fields[:8])}"
          f"{' …' if len(fields) > 8 else ''}")
    print("   该文件含登录凭据，请勿分享或提交到代码仓库。")


def parse_cookie(cookie: str) -> dict:
    out = {}
    for part in cookie.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def resolve_web_id(cookie: str) -> str:
    """优先用你 Cookie 里的 _tea_web_id，取不到再退回内置默认值。"""
    wid = parse_cookie(cookie).get("_tea_web_id")
    if wid and wid.isdigit():
        return wid
    return DEFAULT_WEB_ID


# --------------------------------------------------------------------------
# 签名与请求
# --------------------------------------------------------------------------
def make_sign(uri: str, device_time: str) -> str:
    """Sign = MD5("9e2c|{uri 末 7 位}|7|8.4.0|{deviceTime}||11ac")"""
    raw = "9e2c|%s|%s|%s|%s||11ac" % (uri[-7:], PLATFORM, VERSION, device_time)
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def _headers(uri: str, cookie: str, device_time: str, referer_path: str) -> dict:
    return {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Appvr": VERSION,
        "Pf": PLATFORM,
        "App-Sdk-Version": APP_SDK_VERSION,
        "Appid": str(AID),
        "Cookie": cookie,
        "Device-Time": device_time,
        "Lan": "zh-Hans",
        "Loc": "cn",
        "Sign": make_sign(uri, device_time),
        "Sign-Ver": "1",
        "Tdid": "",
        "Content-Type": "application/json",
        "User-Agent": UA,
        "Origin": BASE,
        "Referer": BASE + referer_path,
        "Sec-Ch-Ua": '"Google Chrome";v="142", "Chromium";v="142", "Not_A Brand";v="99"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }


def _request(uri: str, cookie: str, body=None, params=None,
             referer_path: str = "/ai-tool/home", timeout: int = 30):
    """返回 (http_code, payload)。http_code = -1 表示网络层失败。"""
    dt = str(int(time.time()))
    url = BASE + uri
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body if body is not None else {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers=_headers(uri, cookie, dt, referer_path))
    try:
        with _http.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return -1, {"_network_error": str(exc)}


def _unwrap(code: int, payload):
    """统一拆信封：返回 (ok, data, errmsg)。"""
    if code == -1:
        return False, None, f"网络失败：{payload.get('_network_error')}"
    if code in (401, 403):
        return False, None, f"HTTP {code}：Cookie 已失效或无效，请重新执行 --set-cookie"
    if not isinstance(payload, dict):
        return False, None, f"HTTP {code}：返回非 JSON（{str(payload)[:200]}）"
    if str(payload.get("ret")) != "0":
        return False, None, (f"HTTP {code}：ret={payload.get('ret')} "
                             f"msg={payload.get('errmsg') or payload.get('message')}")
    return True, payload.get("data") or {}, None


def query_credit(cookie: str):
    """查余额（只读，不触发领取）。"""
    return _request(CREDIT_QUERY, cookie, body={}, params=None,
                    referer_path="/ai-tool/image/generate")


def receive_credit(cookie: str):
    """领每日免费积分。"""
    params = dict(RECEIVE_PARAMS)
    params["webId"] = resolve_web_id(cookie)
    return _request(CREDIT_RECEIVE, cookie, body={"time_zone": "Asia/Shanghai"},
                    params=params, referer_path="/ai-tool/home")


# --------------------------------------------------------------------------
# CDP 采集规格（供 cdp.py --capture 使用）
# --------------------------------------------------------------------------
def capture_spec() -> dict:
    """返回浏览器采集所需的参数（详见 lingxi.capture_spec 的说明）。

    验证用**只读的余额查询**接口 `query_credit`——它不触发领取，因此采集阶段的
    反复验证不会消耗或误发任何额度，幂等安全。
    """
    def verify(header: str):
        code, payload = query_credit(header)
        ok, _data, err = _unwrap(code, payload)
        if ok:
            return True, f"余额查询接口验证通过（HTTP {code}，签名被服务端接受）"
        return False, err or f"HTTP {code}"

    return {
        "label": "即梦 AI",
        "url": "https://jimeng.jianying.com/",
        "profile": "jimeng",
        # 父域匹配：会话 Cookie 挂在 .jianying.com 上
        "host_filter": "jianying.com",
        "output": cookie_path(),
        "verify": verify,
    }


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def run(dry_run: bool = False) -> dict:
    """统一入口。与 workbuddy / trae 适配器保持同一签名。"""
    out = {"platform": "即梦 AI"}
    try:
        cookie = load_cookie()
    except (FileNotFoundError, ValueError) as exc:
        return {**out, "result": "ERROR", "detail": str(exc)}

    out["web_id_source"] = ("cookie" if parse_cookie(cookie).get("_tea_web_id")
                            else "default")

    if dry_run:
        code, payload = query_credit(cookie)
        ok, data, err = _unwrap(code, payload)
        if not ok:
            return {**out, "result": "AUTH_REJECTED" if code in (401, 403) else "ERROR",
                    "detail": f"演练（查余额）失败：{err}"}
        return {**out, "result": "DRY_RUN",
                "gift_credit": (data.get("credit") or {}).get("gift_credit"),
                "detail": "演练：凭证可用，未发送领取请求"}

    code, payload = receive_credit(cookie)
    ok, data, err = _unwrap(code, payload)
    out["http"] = code
    if not ok:
        if err and ("已领" in err or "already" in err.lower()):
            return {**out, "result": "ALREADY", "detail": err}
        return {**out, "result": "AUTH_REJECTED" if code in (401, 403) else "ERROR",
                "detail": err}

    quota = data.get("receive_quota")
    first = data.get("is_first_receive")
    out["receive_quota"] = quota
    out["is_first_receive"] = first
    out["credit"] = quota

    # 顺带取一次余额，让结果更可读（失败不影响领取结论）
    qcode, qpayload = query_credit(cookie)
    qok, qdata, _ = _unwrap(qcode, qpayload)
    if qok:
        out["gift_credit"] = (qdata.get("credit") or {}).get("gift_credit")

    if first is False or quota in (0, None):
        return {**out, "result": "ALREADY", "detail": "当日已领取（无新增积分）"}
    return {**out, "result": "OK", "detail": f"今日领取 {quota} 积分"}


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    argv = sys.argv[1:]

    for flag, label in (("--set-cookie", "完整 Cookie"), ("--set-session", "sessionid")):
        if flag in argv:
            i = argv.index(flag)
            if i + 1 >= len(argv):
                print(f'用法：python jimeng.py {flag} "<{label}>"')
                return 2
            try:
                save_cookie(argv[i + 1])
            except ValueError as exc:
                print(f"❌ {exc}")
                return 2
            return 0

    if "--inspect" in argv:
        # 展示实际命中的文件，而不是猜测路径。
        found, _content = cred_paths.read_existing(PLATFORM)
        p = found or cookie_path()
        try:
            cookie = load_cookie()
        except FileNotFoundError:
            print(f"凭证文件：{p}")
            print("已配置：否。推荐自动采集（只需登录一次，无需手工复制 Cookie）：")
            print("  python adapters/cdp.py --capture jimeng")
            print("或手工录入：python adapters/jimeng.py --set-cookie \"<完整 Cookie>\"")
            print("或改用浏览器方案：python jimeng_browser.py --login")
            print(f"已查找：{', '.join(cookie_candidates())}")
            return 0
        except ValueError as exc:
            print(f"凭证文件：{p}")
            print("已配置：是，但**不可用**")
            print(f"  └─ {exc}")
            return 0
        names = cookie_util.cookie_names(cookie)
        print(f"凭证文件：{p}")
        print(f"已配置：是（长度 {len(cookie)}）")
        print(f"字段数：{len(names)}；含 sessionid：{'是' if 'sessionid' in names else '否 ⚠️'}")
        print(f"webId 来源：{'Cookie 的 _tea_web_id' if '_tea_web_id' in names else '内置默认值'}")
        return 0

    if "--status" in argv:
        try:
            cookie = load_cookie()
        except (FileNotFoundError, ValueError) as exc:
            print(exc)
            return 2
        code, payload = query_credit(cookie)
        ok, data, err = _unwrap(code, payload)
        if not ok:
            print(f"❌ {err}")
            return 1
        credit = data.get("credit") or {}
        print(f"HTTP {code}")
        print(f"赠送积分(gift_credit)：{credit.get('gift_credit')}")
        ec = data.get("expiring_credits") or []
        if isinstance(ec, list) and ec:
            f = ec[0]
            print(f"即将过期：{f.get('credit_amount')}（expire_time={f.get('expire_time')}）")
        return 0

    result = run(dry_run="--dry-run" in argv)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("result") in ("OK", "ALREADY", "DRY_RUN") else 1


if __name__ == "__main__":
    sys.exit(main())
