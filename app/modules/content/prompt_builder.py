# -*- coding: utf-8 -*-
"""
内容创作 Prompt 构建器
深度集成 xiaohongshu-ops skill 的框架：
  - persona.md        → 虾薯人设/语气规范
  - xhs-topic-ideation → 选题生成 SOP
  - xhs-home-feed-analysis → 内容结构分析框架
  - SKILL.md §4       → 通用内容模板（标题/钩子/正文/互动/话题）
"""

import json
from typing import Optional

from app.models.item import Item, ReferenceAccount


def _build_persona_block(my_profile: Optional[dict] = None) -> str:
    """
    优先使用数据库中的 my_profile 人设，
    回退到 skill persona.md 的硬编码默认值。
    """
    if my_profile:
        name        = my_profile.get("persona_name") or my_profile.get("display_name") or "虾薯"
        bio         = my_profile.get("persona_bio") or ""
        tone        = my_profile.get("persona_tone") or ""
        niche       = my_profile.get("niche") or ""
        audience    = my_profile.get("target_audience") or ""
        taboos_raw  = my_profile.get("persona_taboos") or "[]"
        try:
            taboos = json.loads(taboos_raw)
        except Exception:
            taboos = []
        taboos_str = "、".join(taboos) if taboos else "精致/高级感/高品质/氛围感等空话"

        pillars_raw = my_profile.get("content_pillars") or "[]"
        try:
            pillars = json.loads(pillars_raw)
        except Exception:
            pillars = []
        pillars_str = "、".join(pillars) if pillars else ""

        styles_raw = my_profile.get("preferred_styles") or "[]"
        try:
            styles = json.loads(styles_raw)
        except Exception:
            styles = []
        styles_str = "、".join(styles) if styles else ""

        return f"""**账号人设（来自我的账号设定）**
- 账号名：{my_profile.get("display_name", "")}
- 人设昵称：{name}{f"  ——  {bio}" if bio else ""}
- 垂类定位：{niche}
- 目标受众：{audience}
{f"- 内容支柱：{pillars_str}" if pillars_str else ""}
{f"- 偏好风格：{styles_str}" if styles_str else ""}
- 语气规范：{tone if tone else "口语化，短句换行，先吐槽痛点再给结论，不说空话"}
- 禁忌：禁止出现 [{taboos_str}] 等词汇
"""
    # 回退默认值
    return _PERSONA


# ──────────────────────────────────────────────────────────────
# Persona（来自 skill/persona.md）
# ──────────────────────────────────────────────────────────────

# 家居垂类专属人设（在 skill 通用 persona 基础上垂直化）
_PERSONA = """
**账号人设（家居垂类·虾薯人设变体）**
- 身份：住在出租屋/自购房里的普通居家人，花不了大价钱但很会搭
- 气质：务实嘴硬，不说"精致生活"，只说"这个真的好用/踩坑了别买"
- 语气规范（来自 persona.md）：
  - 短句换行，不写小作文，一段落不超过 4 行
  - 嘴硬开头：可以先吐槽痛点，再给结论
  - 点到为止：最多给 1 个核心卖点，不做清单式堆砌
  - 收尾：陈述句为主，偶尔轻飘飘一句反问引导互动
  - 表情：克制，最多 1 个，不在每句后面堆表情
- 禁忌：
  - 禁止说"精致/高品质/高级感/氛围感"等空话
  - 禁止虚构使用经历
  - 禁止隐性承诺（"我后面出教程"）
"""

# ──────────────────────────────────────────────────────────────
# 内容结构框架（来自 SKILL.md §4 + xhs-home-feed-analysis）
# ──────────────────────────────────────────────────────────────

_CONTENT_TEMPLATE_GUIDE = """
**内容结构框架（小红书家居图文）**

标题规则（来自 skill §4 + xhs-home-feed-analysis 可复用模式）：
- ≤20 字，带情绪词/反问/立场，3 种句式骨架：
  - 情绪型：「被___惊到了」「折腾___后我麻了」「买了___朋友以为我花大钱」
  - 问题型：「为什么___」「___到底值不值」「别再___了」
  - 场景型：「___的房间就该这样搭」「住进___，我才明白___」

封面文案（大字报风格）：
- 1-2 句，≤15 字，直接点出核心卖点或情绪冲突
- 例：「花 200 配出 2000 的感觉」「终于找到它了」

正文结构（3 段，共 150-300 字）：
- 第 1 段：场景/痛点钩子（1-2 句，勾住停留）
- 第 2 段：物品特点/实际体验（核心信息，口语化）
- 第 3 段：搭配建议 or 使用感受（让读者产生代入）

互动引导（结尾 1 句）：
- 站队型：「你更偏哪种风格？」
- 经验型：「有没有更好看的搭配方案？」
- 选择型：「A 还是 B，告诉我你的选择」

话题标签（5-8 个，来自 skill §3C）：
- 主话题（1）：#家居好物 / #软装分享 / #装修日记
- 场景话题（2）：#客厅布置 / #卧室装饰 等
- 风格话题（1-2）：#北欧风 / #奶油风 等
- 情绪话题（1-2）：#治愈系家居 / #小而美 等
"""

# ──────────────────────────────────────────────────────────────
# 选题生成框架（来自 xhs-topic-ideation.md）
# ──────────────────────────────────────────────────────────────

_TOPIC_IDEATION_GUIDE = """
**选题生成框架（来自 xhs-topic-ideation.md）**

每条选题必须包含：
1. 主题对象：人 / 事 / 产品 / 场景 / 问题
2. 主题动作：分享 / 对比 / 复盘 / 踩坑 / 观点
3. 主题情绪：爽感 / 焦虑 / 争议 / 共鸣 / 反差
4. 主题收益：省钱 / 省时间 / 少踩坑 / 变好看

可复用标题骨架（优先用这些）：
- 「为什么___」
- 「我发现___」
- 「___到底值不值」
- 「别再___了」
- 「___这件事，最容易被忽略的其实是___」

互动钩子类型（每条选题必选一种）：
- 站队型：「你更偏哪边」
- 复盘型：「你遇到过吗」
- 选择型：「如果是你会怎么选」
- 经验型：「你有没有更好的搭法」

筛选标准（每条都要过）：
- 可讲性（能用 3 段讲清楚）
- 可争议（有一点分歧，但不失控）
- 可持续（能延展成系列）
- 可转发（有让人顺手转给别人的理由）
"""

# ──────────────────────────────────────────────────────────────
# 默认风格指引（无榜样账号时使用）
# ──────────────────────────────────────────────────────────────

_DEFAULT_STYLE_GUIDE = """
**默认内容风格**
- 标题：20 字以内，带情绪词或反问，避免营销腔
- 开头：1-2 句场景描述或痛点共鸣
- 正文：3 段结构（钩子→体验→搭配/建议），150-300 字
- 话题：5-8 个，主话题 + 场景话题 + 风格话题
- 语气：口语化，像跟朋友分享，不说空话套话
"""


# ──────────────────────────────────────────────────────────────
# 公共 API
# ──────────────────────────────────────────────────────────────

def build_draft_prompt(
    item: Item,
    reference: Optional[ReferenceAccount] = None,
    my_profile: Optional[dict] = None,
    extra_instructions: str = "",
) -> str:
    """
    为指定物品构建笔记创作 prompt。
    my_profile: 来自 my_profile 表的 dict（优先于硬编码 persona）。
    """
    # ── 物品信息块 ──
    analysis = {}
    if item.analysis_raw:
        try:
            analysis = json.loads(item.analysis_raw)
        except Exception:
            pass

    selling_points = analysis.get("xhs_selling_points", [])
    pairing = analysis.get("pairing_suggestions", "")

    item_block = f"""## 物品信息（MiniMax 分析结果）
- 名称：{item.title}
- 风格：{item.style or '—'}
- 材质：{item.material or '—'}
- 颜色：{item.color or '—'}
- 适用场景：{item.scene or '—'}
- 标签：{item.tags_str()}
"""
    if selling_points:
        item_block += f"- 小红书卖点：{'  /  '.join(selling_points)}\n"
    if pairing:
        item_block += f"- 搭配建议：{pairing}\n"

    # ── 榜样账号风格块 ──
    if reference:
        style_block = f"\n## 参考账号风格（{reference.name or reference.account_id}）\n"
        if reference.content_style:
            try:
                cs = json.loads(reference.content_style)
                for k, v in cs.items():
                    style_block += f"- {k}：{v}\n"
            except Exception:
                style_block += reference.content_style + "\n"
        if reference.top_notes:
            style_block += "\n参考账号高赞笔记标题（学习句式，不要照抄）：\n"
            for n in reference.top_notes[:5]:
                style_block += f"  - {n.get('title', '')} （赞 {n.get('likes', 0)}）\n"
    elif not my_profile:
        # 没有 my_profile 也没有 reference，使用默认风格说明
        style_block = f"\n{_DEFAULT_STYLE_GUIDE}"
    else:
        style_block = ""

    # ── 任务说明块（含 skill 框架）──
    persona_block = _build_persona_block(my_profile)
    task_block = f"""
{persona_block}

{_CONTENT_TEMPLATE_GUIDE}

## 任务
根据上面所有信息，为【{item.title}】生成一篇小红书家居图文笔记。

请严格按以下格式输出：

---标题候选（3 个）---
情绪型：
问题型：
场景型：

---封面文案---
（≤15 字，大字报风格）

---正文---
（第 1 段·钩子）

（第 2 段·核心体验/特点）

（第 3 段·搭配/场景代入）

---互动引导---
（结尾 1 句）

---话题标签---
（5-8 个，格式：#话题名，空格分隔）

---创作备注---
（说明选了哪种情绪角度、为什么，方便后续 A/B 测试）
"""

    extra = f"\n## 补充要求\n{extra_instructions}\n" if extra_instructions else ""

    return item_block + style_block + extra + task_block


def build_multi_draft_prompt(
    items: list,
    reference: Optional[ReferenceAccount] = None,
    my_profile: Optional[dict] = None,
    extra_instructions: str = "",
) -> str:
    """
    将多个物品合并成一个笔记的创作 Prompt。
    适合「把这几件物品搭配在一起写一篇笔记」的场景。
    """
    # ── 多物品信息块 ──
    items_block = "## 物品清单（本次创作涉及的物品，需整合到同一篇笔记中）\n"
    for idx, item in enumerate(items, 1):
        analysis = {}
        if item.analysis_raw:
            try:
                analysis = json.loads(item.analysis_raw)
            except Exception:
                pass
        selling_points = analysis.get("xhs_selling_points", [])
        pairing = analysis.get("pairing_suggestions", "")

        items_block += f"\n### 物品 {idx}：{item.title}\n"
        items_block += f"- 风格：{item.style or '—'}  材质：{item.material or '—'}  颜色：{item.color or '—'}\n"
        items_block += f"- 适用场景：{item.scene or '—'}\n"
        if item.tags:
            items_block += f"- 标签：{item.tags_str()}\n"
        if selling_points:
            items_block += f"- 卖点：{'  /  '.join(selling_points)}\n"
        if pairing:
            items_block += f"- 搭配建议：{pairing}\n"

    # ── 榜样账号风格块 ──
    if reference:
        style_block = f"\n## 参考账号风格（{reference.name or reference.account_id}）\n"
        if reference.content_style:
            try:
                cs = json.loads(reference.content_style)
                for k, v in cs.items():
                    style_block += f"- {k}：{v}\n"
            except Exception:
                style_block += reference.content_style + "\n"
        if reference.top_notes:
            style_block += "\n参考账号高赞笔记标题（学习句式，不要照抄）：\n"
            for n in reference.top_notes[:5]:
                style_block += f"  - {n.get('title', '')} （赞 {n.get('likes', 0)}）\n"
    elif not my_profile:
        style_block = f"\n{_DEFAULT_STYLE_GUIDE}"
    else:
        style_block = ""

    # ── 任务说明块 ──
    item_names = "、".join(item.title for item in items)
    persona_block = _build_persona_block(my_profile)
    task_block = f"""
{persona_block}

{_CONTENT_TEMPLATE_GUIDE}

## 任务
根据上面【{len(items)} 件物品】的信息，写一篇把它们整合在一起的小红书家居图文笔记。
涉及物品：{item_names}

创作重点：
- 找到这几件物品之间的「搭配逻辑」或「同一场景的使用感受」
- 不要逐一罗列，而是以场景/故事驱动，自然带出每件物品
- 如果物品间有明显搭配关系，以搭配效果为核心卖点

请严格按以下格式输出：

---标题候选（3 个）---
情绪型：
问题型：
场景型：

---封面文案---
（≤15 字，大字报风格）

---正文---
（第 1 段·钩子）

（第 2 段·核心体验/特点）

（第 3 段·搭配/场景代入）

---互动引导---
（结尾 1 句）

---话题标签---
（5-8 个，格式：#话题名，空格分隔）

---创作备注---
（说明选了哪种情绪角度、如何整合多个物品、方便后续 A/B 测试）
"""

    extra = f"\n## 补充要求\n{extra_instructions}\n" if extra_instructions else ""

    return items_block + style_block + extra + task_block


def build_topic_prompt(
    item_titles: list[str],
    reference: Optional[ReferenceAccount] = None,
    crawl_analysis_summary: str = "",
    extra_instructions: str = "",
) -> str:
    """
    根据图库物品列表 + 爬虫分析摘要，生成选题清单 prompt。
    来自 skill xhs-topic-ideation.md SOP。
    """
    items_str = "\n".join(f"  - {t}" for t in item_titles)

    account_block = ""
    if reference:
        account_block = f"\n## 参考账号（{reference.name or reference.account_id}）\n"
        if reference.content_style:
            try:
                cs = json.loads(reference.content_style)
                account_block += f"- 风格：{cs.get('标题风格', '')} / {cs.get('情绪调性', '')}\n"
            except Exception:
                pass
        account_block += f"- 平均点赞：{reference.avg_likes}  评论：{reference.avg_comments}\n"

    crawl_block = ""
    if crawl_analysis_summary:
        crawl_block = f"\n## 近期爬虫分析摘要（平台热信号）\n{crawl_analysis_summary}\n"

    task_block = f"""
## 图库物品清单（待出内容的原材料）
{items_str}

{account_block}
{crawl_block}
{_TOPIC_IDEATION_GUIDE}

{_PERSONA}

## 任务
基于以上物品清单、平台热信号和账号人设，生成 5 条可直接发布的小红书选题。

每条选题按以下格式输出：

### 选题 N
- 标题：（≤20 字）
- 选题角度：（支持/反对/中立/争议）
- 目标人群：（谁最容易点进来）
- 互动钩子：（结尾用的那句话）
- 内容结构：
  - 第 1 段（钩子）：
  - 第 2 段（核心）：
  - 第 3 段（收尾）：
- 涉及物品：（从上面清单中选）
- 风险提示：（是否容易引战 / 踩线）

---
输出完 5 条后，另起一行给出「优先级排序」和「推荐先发哪条及理由」。
"""

    extra = f"\n## 补充要求\n{extra_instructions}\n" if extra_instructions else ""

    return task_block + extra


def build_style_analysis_prompt(account_notes: list) -> str:
    """
    根据账号笔记数据，生成账号风格分析 prompt。
    结果可存入 reference_accounts.content_style（JSON）。
    来自 skill §2.5 账号分析。
    """
    titles = [
        (n.get("title") or n.get("desc") or "")[:60]
        for n in account_notes[:20]
        if n.get("title") or n.get("desc")
    ]
    titles_str = "\n".join(f"  - {t}" for t in titles)

    return f"""以下是一个小红书家居账号的高赞笔记标题（共 {len(titles)} 条）：

{titles_str}

请按 skill xhs-account-analysis.md 的框架，分析这个账号的内容风格，用 JSON 格式返回：
{{
  "标题风格": "（常用什么句式结构）",
  "常用句式": "（1-2 个可复用骨架）",
  "情绪调性": "（整体情绪倾向）",
  "内容侧重": "（主要聊什么：好物/踩坑/搭配/改造）",
  "互动钩子": "（评论区引导词常见类型）",
  "禁忌": "（这个账号明显不做的事）",
  "可学之处": "（最值得本账号参考的 1-2 点）"
}}
只返回 JSON，不要其他说明。"""
