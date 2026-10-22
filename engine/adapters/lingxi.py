#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WPS 灵犀（lingxi.wps.cn）每日签到适配器

与即梦不同，灵犀**有真实的领取接口**，可以真正完成签到，不需要浏览器。

接口规格（已用无 Cookie 请求探针验证接口存在：返回 401 UserUnauthorized）
------------------------------------------------------------------------
  任务面板  GET  /api/public/v1/tasks?date=YYYY-MM-DD
            → data.tasks[]，其中 task_key == "daily_check_in" 的那条是每日签到任务，
              字段：reward_amount（默认 100 智点）、status（claimed / incomplete / locked）
  每日签到  POST /api/public/v1/tasks/daily_check_in/claim?date=YYYY-MM-DD   body {}
            → data（含 task_key / trade_no / total_claimed_credits）
              已签幂等：重复调用仍返回 200，不会重复发放

  鉴权：登录 Cookie（*.wps.cn，核心会话为 HttpOnly）

凭证
----
存放于上一级的 `lx_cookie.txt`，或环境变量 `LX_COOKIE`。

用法
----
    python adapters/cdp.py --capture lingxi                # ★ 首次：自动采集（推荐）
    python lingxi.py --set-cookie "<完整 Cookie 字符串>"   # 首次：手工录入
    python lingxi.py --inspect                             # 检查凭证配置
    python lingxi.py --status                              # 只查任务面板，不签到
    python lingxi.py --dry-run                             # 演练（不发领取请求）
    python lingxi.py                                       # 执行签到

如何取 Cookie
-------------
**推荐**：`python adapters/cdp.py --capture lingxi`
会自动弹窗，你登录一次，程序用只读的任务面板接口验证通过后自动保存，
**不需要手工复制 Cookie**。

手工方式（备选）：
1. 浏览器打开 https://lingxi.wps.cn/ 并登录
2. F12 → Application（应用）→ Storage → Cookies → https://lingxi.wps.cn
3. 全选该域下所有 Cookie（**注意核心会话是 HttpOnly，务必全选，不要只挑非 HttpOnly 的**），
   拼成 `k=v; k2=v2; ...` 一行，执行 --set-cookie

Cookie 有效期：不定期失效，失效后本模块会明确报「登录态失效」，重捕即可。

⚠️ 说明：接口规格来自线上跑通的开源实现，且已实测「无 Cookie → 401」与
「假 Cookie → 401」，说明鉴权路径与判据可靠；端到端签到待你录 Cookie 后实测。
"""

from __future__ import annotations

import datetime
import json
import os
import sys
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

API = "https://lingxi.wps.cn/api/public/v1/tasks"
SITE = "https://lingxi.wps.cn/"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

TASK_KEY = "daily_check_in"
DEFAULT_REWARD = 100

_HERE = os.path.dirname(os.path.abspath(__file__))

# 平台 id（供 cred_paths 定位凭证文件）。
PLATFORM = "lingxi"


# --------------------------------------------------------------------------
# 凭证
#
# 路径不再由本模块自己拼——统一交给 cred_paths，与 JS 侧
# （lib/connect/lingxi/credentials.js）用同一份规则。
# 详见 cred_paths 模块顶部的说明：包内凭证文件会随重装被抹掉，
# 权威位置是 <dshHome>/dsh-agent-checkin/engine/。
# --------------------------------------------------------------------------
def cookie_path() -> str:
    """写入凭证的目标路径（主位置：用户可写、重装不丢）。"""
    return cred_paths.write_target(PLATFORM)


def cookie_candidates() -> list[str]:
    """按优先级列出所有候选凭证路径（供 --inspect 展示）。"""
    return cred_paths.candidates(PLATFORM)


def load_cookie() -> str:
    env = os.environ.get("LX_COOKIE", "").strip()
    if env:
        return _validated(env, "环境变量 LX_COOKIE")
    path, raw = cred_paths.read_existing(PLATFORM)
    if path and raw:
        return _validated(raw, path)
    raise FileNotFoundError(
        "未配置 WPS 灵犀登录 Cookie。\n"
        "  推荐（自动采集，只需登录一次，无需手工复制 Cookie）：\n"
        "      python adapters/cdp.py --capture lingxi\n"
        "  或手工录入：\n"
        "      python adapters/lingxi.py --set-cookie \"<完整 Cookie>\"\n"
        f"（凭证写入位置：{cookie_path()}）\n"
        f"（已查找：{', '.join(cookie_candidates())}）")


def _validated(raw: str, where: str) -> str:
    """已存盘的凭证也要校验——防止把占位符当成真凭证使用。"""
    ok, why = cookie_util.usability(raw)
    if not ok:
        raise ValueError(
            f"凭证不可用（{where}）：{why}\n"
            f"  请重新采集：python adapters/cdp.py --capture lingxi\n"
            f"  或手工录入：python adapters/lingxi.py --set-cookie \"<真实 Cookie>\"")
    return raw


def save_cookie(value: str) -> None:
    # 灵犀不支持「裸令牌」写法：它的会话 Cookie 是多条，只给一个值不可能有效
    value = cookie_util.normalize(value, platform="WPS 灵犀",
                                  allow_bare_token=False)
    p = cookie_path()
    cred_paths.ensure_parent(p)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(value)
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    fields = cookie_util.cookie_names(value)
    print(f"✅ 凭证已保存到：{p}")
    print(f"   字段 {len(fields)} 个：{', '.join(fields[:8])}"
          f"{' …' if len(fields) > 8 else ''}")
    print("   该文件含登录凭据，请勿分享或提交到代码仓库。")


# --------------------------------------------------------------------------
# 请求
# --------------------------------------------------------------------------
def _request(path: str, cookie: str, method: str = "GET",
             body=None, timeout: int = 20):
    """返回 (http_code, payload)。http_code = -1 表示网络层失败。"""
    url = API + path
    headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Referer": SITE,
        "Origin": SITE.rstrip("/"),
        "Cookie": cookie,
    }
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
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
        hint = payload.get("hint") if isinstance(payload, dict) else ""
        return False, None, (f"登录态失效（HTTP {code}）：{hint or 'UserUnauthorized'}。"
                             f"请在浏览器重新登录 lingxi.wps.cn 后执行 --set-cookie")
    if not isinstance(payload, dict):
        return False, None, f"HTTP {code}：返回非 JSON（{str(payload)[:200]}）"
    result = str(payload.get("result") or "").lower()
    if result and result not in ("ok", "success"):
        return False, None, (f"HTTP {code}：result={payload.get('result')} "
                             f"msg={payload.get('msg')}")
    if "data" not in payload:
        return False, None, f"HTTP {code}：返回结构异常（无 data 字段）"
    return True, payload.get("data") or {}, None


def query_tasks(cookie: str, day: str):
    """查任务面板（只读）。"""
    return _request("/?date=" + urllib.parse.quote(day), cookie, method="GET")


def claim_daily(cookie: str, day: str):
    """领取每日签到奖励。"""
    return _request("/daily_check_in/claim?date=" + urllib.parse.quote(day),
                    cookie, method="POST", body={})


def _find_daily(data) -> dict:
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if not isinstance(tasks, list):
        return {}
    for t in tasks:
        if isinstance(t, dict) and t.get("task_key") == TASK_KEY:
            return t
    return {}


def _is_claimed(daily: dict) -> bool:
    return daily.get("status") == "claimed" or bool(daily.get("checked"))


# --------------------------------------------------------------------------
# CDP 采集规格（供 cdp.py --capture 使用）
# --------------------------------------------------------------------------
def capture_spec() -> dict:
    """返回浏览器采集所需的参数。

    放在适配器里而不是 cdp.py 里，是为了让常量只有一个出处——避免
    「改了适配器的域名/字段名，忘了改采集配置」这类漂移。

    验证策略：**不靠猜登录 Cookie 的名字**，而是拿采集到的 Cookie 去真实调用
    任务面板接口。名字猜测会随平台改版失效，功能验证不会——接口通了就说明
    登录真的成功，这才是可信的判据。
    """
    def verify(header: str):
        day = datetime.date.today().isoformat()
        code, payload = query_tasks(header, day)
        ok, data, err = _unwrap(code, payload)
        if ok:
            n = len(data.get("tasks") or []) if isinstance(data, dict) else 0
            return True, f"任务面板接口验证通过（HTTP {code}，返回 {n} 条任务）"
        return False, err or f"HTTP {code}"

    return {
        "label": "WPS 灵犀",
        "url": SITE,
        "profile": "lingxi",
        # 用父域匹配：WPS 的会话 Cookie 挂在 .wps.cn 上，
        # 若写成 lingxi.wps.cn 反而一条都匹配不到（子串判断不反向匹配）
        "host_filter": "wps.cn",
        "output": cookie_path(),
        "verify": verify,
    }


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def run(dry_run: bool = False) -> dict:
    out = {"platform": "WPS 灵犀"}
    try:
        cookie = load_cookie()
    except (FileNotFoundError, ValueError) as exc:
        return {**out, "result": "ERROR", "detail": str(exc)}

    today = datetime.date.today().isoformat()
    out["date"] = today

    code, payload = query_tasks(cookie, today)
    ok, data, err = _unwrap(code, payload)
    out["status_http"] = code
    if not ok:
        return {**out, "result": "AUTH_REJECTED" if code in (401, 403) else "ERROR",
                "detail": err}

    daily = _find_daily(data)
    if not daily:
        return {**out, "result": "INACTIVE",
                "detail": f"任务面板里没有 {TASK_KEY} 任务，活动可能已下线或改版"}

    reward = daily.get("reward_amount") or DEFAULT_REWARD
    out["reward"] = reward
    out["task_status"] = daily.get("status")

    if _is_claimed(daily):
        return {**out, "result": "ALREADY", "detail": "今日已签到",
                "credit": reward}

    if str(daily.get("status")) == "locked":
        return {**out, "result": "INACTIVE", "detail": "任务处于 locked 状态，今日不可签"}

    if dry_run:
        return {**out, "result": "DRY_RUN",
                "detail": f"演练：今日未签，将领取 +{reward} 智点"}

    code2, payload2 = claim_daily(cookie, today)
    ok2, data2, err2 = _unwrap(code2, payload2)
    out["claim_http"] = code2
    if not ok2:
        if "已签" in err2 or "already" in err2.lower():
            return {**out, "result": "ALREADY", "detail": err2, "credit": reward}
        return {**out, "result": "AUTH_REJECTED" if code2 in (401, 403) else "ERROR",
                "detail": err2}

    total = data2.get("total_claimed_credits")
    out["total_claimed"] = total
    out["credit"] = reward
    msg = f"今日 +{reward} 智点"
    if total is not None:
        msg += f"（累计 {total}）"
    return {**out, "result": "OK", "detail": msg}


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    argv = sys.argv[1:]

    if "--set-cookie" in argv:
        i = argv.index("--set-cookie")
        if i + 1 >= len(argv):
            print('用法：python lingxi.py --set-cookie "<完整 Cookie>"')
            return 2
        try:
            save_cookie(argv[i + 1])
        except ValueError as exc:
            print(f"❌ {exc}")
            return 2
        return 0

    if "--inspect" in argv:
        # 展示「实际命中的文件」而不是「猜测的路径」——路径解析有多处候选，
        # 报告读的那一个，才不会让人对着空文件找原因。
        found, _content = cred_paths.read_existing(PLATFORM)
        p = found or cookie_path()
        try:
            cookie = load_cookie()
        except FileNotFoundError:
            print(f"凭证文件：{p}")
            print("已配置：否。推荐自动采集（只需登录一次，无需手工复制 Cookie）：")
            print("  python adapters/cdp.py --capture lingxi")
            print("或手工录入：python adapters/lingxi.py --set-cookie \"<完整 Cookie>\"")
            print(f"已查找：{', '.join(cookie_candidates())}")
            return 0
        except ValueError as exc:
            print(f"凭证文件：{p}")
            print("已配置：是，但**不可用**")
            print(f"  └─ {exc}")
            return 0
        fields = cookie_util.cookie_names(cookie)
        print(f"凭证文件：{p}")
        print(f"已配置：是（长度 {len(cookie)}，字段 {len(fields)} 个）")
        # 只报字段名，不打印任何值
        print(f"字段名：{', '.join(fields[:12])}{' …' if len(fields) > 12 else ''}")
        return 0

    if "--status" in argv:
        try:
            cookie = load_cookie()
        except (FileNotFoundError, ValueError) as exc:
            print(exc)
            return 2
        today = datetime.date.today().isoformat()
        code, payload = query_tasks(cookie, today)
        ok, data, err = _unwrap(code, payload)
        if not ok:
            print(f"❌ {err}")
            return 1
        daily = _find_daily(data)
        print(f"HTTP {code}   日期 {today}")
        print(f"签到任务：{json.dumps(daily, ensure_ascii=False)}")
        return 0

    result = run(dry_run="--dry-run" in argv)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("result") in ("OK", "ALREADY", "DRY_RUN") else 1


if __name__ == "__main__":
    sys.exit(main())
