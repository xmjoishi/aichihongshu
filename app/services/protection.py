# -*- coding: utf-8 -*-
"""操作权限中间件（v0.3）

设计要点：
  - 顶栏激活账号一定是 operation；assistant 不会出现在 active 上下文（service 已限制）
  - 所以 guard 只针对 operation 账号设策略
  - 高风险操作（搜索/榜样抓取）建议用户切换到 assistant 浏览器执行，
    在 operation 账号下执行会触发二次确认（提醒用户用辅助账号）

策略矩阵（仅 operation）：
  publish_auto      : allow      （核心场景，直接放行）
  crawler_search    : warn       （高频抓取风险高，建议改用 assistant）
  crawler_creator   : warn       （同上）
  profile_refresh   : allow      （刷新自己主页风险低）
  browser_open      : allow      （仅打开浏览器，无副作用）

  - allow         直接放行
  - warn          需要二次确认（前端弹窗，请求 header X-Risk-Acknowledged: yes）
  - block         直接拦截（HTTP 403，本版本不再使用）
"""

from typing import Optional

from fastapi import Header, HTTPException

from app.services import account_pool


PROTECTION_MATRIX: dict[str, dict[str, str]] = {
    "operation": {
        "publish_auto":    "allow",
        "crawler_search":  "warn",
        "crawler_creator": "warn",
        "profile_refresh": "allow",
        "browser_open":    "allow",
    },
}

ACTION_LABEL_CN = {
    "publish_auto":    "自动发布笔记",
    "crawler_search":  "关键词搜索抓取",
    "crawler_creator": "榜样账号抓取",
    "profile_refresh": "刷新主页数据",
    "browser_open":    "打开浏览器",
}


def get_policy(action: str) -> str:
    """返回当前激活账号针对该 action 的策略（默认 allow）。"""
    active = account_pool.get_active()
    if not active:
        return "allow"
    role = active.get("role", "operation")
    return PROTECTION_MATRIX.get(role, {}).get(action, "allow")


def check_action(action: str, acknowledged: bool = False) -> dict:
    """检查某个动作是否允许执行。"""
    policy = get_policy(action)
    active = account_pool.get_active() or {}
    alias = active.get("alias", "未知账号")
    action_cn = ACTION_LABEL_CN.get(action, action)

    if policy == "block":
        raise HTTPException(
            403,
            f"权限不足：当前账号「{alias}」禁止执行「{action_cn}」。",
        )
    if policy == "warn" and not acknowledged:
        raise HTTPException(
            428,
            {
                "code": "REQUIRES_CONFIRMATION",
                "action": action,
                "alias": alias,
                "message": (
                    f"⚠️ 高风险操作二次确认\n\n"
                    f"当前是运营账号「{alias}」，执行「{action_cn}」可能触发小红书风控。\n"
                    f"建议切换到「辅助账号」浏览器执行；如确认要用本账号继续，请确认。"
                ),
            },
        )
    return {
        "policy": policy,
        "allow": True,
        "requires_confirmation": policy == "warn",
        "alias": alias,
    }


def require_protection(action: str):
    """FastAPI dependency 工厂。"""
    def _dep(x_risk_acknowledged: Optional[str] = Header(None)):
        ack = (x_risk_acknowledged or "").lower() in ("yes", "true", "1", "ok")
        return check_action(action, acknowledged=ack)

    return _dep
