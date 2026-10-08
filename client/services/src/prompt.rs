use aichihongshu_db::{
    ItemSummary, LocalContentKnowledgeContext, ProfileSummary, ReferenceAccountSummary,
};
use serde_json::Value;

const CONTENT_GUIDE: &str = r#"
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
"#;

const DEFAULT_PERSONA: &str = r#"
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
"#;

const DEFAULT_STYLE: &str = r#"
**默认内容风格**
- 标题：20 字以内，带情绪词或反问，避免营销腔
- 开头：1-2 句场景描述或痛点共鸣
- 正文：3 段结构（钩子→体验→搭配/建议），150-300 字
- 话题：5-8 个，主话题 + 场景话题 + 风格话题
- 语气：口语化，像跟朋友分享，不说空话套话
"#;

const TOPIC_GUIDE: &str = r#"
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
"#;

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn legacy_float(value: f64) -> String {
    let formatted = value.to_string();
    if value.is_finite()
        && value.fract() == 0.0
        && !formatted.contains('.')
        && !formatted.contains('e')
        && !formatted.contains('E')
    {
        format!("{formatted}.0")
    } else {
        formatted
    }
}

fn persona_block(profile: Option<&ProfileSummary>) -> String {
    let Some(profile) = profile else {
        return DEFAULT_PERSONA.to_string();
    };
    let name = profile
        .persona_name
        .as_deref()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            profile
                .display_name
                .as_deref()
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("虾薯");
    let taboos = if profile.persona_taboos.is_empty() {
        "精致/高级感/高品质/氛围感等空话".to_string()
    } else {
        profile.persona_taboos.join("、")
    };
    let tone = profile
        .persona_tone
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("口语化，短句换行，先吐槽痛点再给结论，不说空话");
    let bio = profile
        .persona_bio
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|bio| format!("  ——  {bio}"))
        .unwrap_or_default();
    let mut block = format!(
        "**账号人设（来自我的账号设定）**\n- 账号名：{}\n- 人设昵称：{}{bio}\n- 垂类定位：{}\n- 目标受众：{}\n",
        profile.display_name.as_deref().unwrap_or(""),
        name,
        profile.niche.as_deref().unwrap_or(""),
        profile.target_audience.as_deref().unwrap_or(""),
    );
    if !profile.content_pillars.is_empty() {
        block.push_str(&format!(
            "- 内容支柱：{}\n",
            profile.content_pillars.join("、")
        ));
    }
    if !profile.preferred_styles.is_empty() {
        block.push_str(&format!(
            "- 偏好风格：{}\n",
            profile.preferred_styles.join("、")
        ));
    }
    block.push_str(&format!(
        "- 语气规范：{tone}\n- 禁忌：禁止出现 [{taboos}] 等词汇\n"
    ));
    block
}

pub fn build_draft_prompt(
    item: &ItemSummary,
    profile: Option<&ProfileSummary>,
    reference: Option<&ReferenceAccountSummary>,
    extra_instructions: &str,
) -> String {
    build_draft_prompt_with_knowledge(item, profile, reference, extra_instructions, None)
}

pub fn build_draft_prompt_with_knowledge(
    item: &ItemSummary,
    profile: Option<&ProfileSummary>,
    reference: Option<&ReferenceAccountSummary>,
    extra_instructions: &str,
    knowledge: Option<&LocalContentKnowledgeContext>,
) -> String {
    let analysis = item
        .analysis_raw
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or(Value::Null);
    let selling_points = strings(analysis.get("xhs_selling_points"));
    let pairing = analysis
        .get("pairing_suggestions")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut item_block = format!(
        "## 物品信息（MiniMax 分析结果）\n- 名称：{}\n- 风格：{}\n- 材质：{}\n- 颜色：{}\n- 适用场景：{}\n- 标签：{}\n",
        item.title,
        item.style.as_deref().unwrap_or("—"),
        item.material.as_deref().unwrap_or("—"),
        item.color.as_deref().unwrap_or("—"),
        item.scene.as_deref().unwrap_or("—"),
        if item.tags.is_empty() { "—".to_string() } else { item.tags.join("、") },
    );
    if !selling_points.is_empty() {
        item_block.push_str(&format!("- 小红书卖点：{}\n", selling_points.join("  /  ")));
    }
    if !pairing.is_empty() {
        item_block.push_str(&format!("- 搭配建议：{pairing}\n"));
    }

    let style_block = if let Some(reference) = reference {
        reference_style_block(reference)
    } else if profile.is_none() {
        format!("\n{DEFAULT_STYLE}")
    } else {
        String::new()
    };

    let persona = persona_block(profile);
    let task = format!(
        r#"
{persona}

{CONTENT_GUIDE}

## 任务
根据上面所有信息，为【{}】生成一篇小红书家居图文笔记。

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
"#,
        item.title
    );
    let extra = if extra_instructions.is_empty() {
        String::new()
    } else {
        format!("\n## 补充要求\n{extra_instructions}\n")
    };
    let knowledge_block = knowledge.map(build_knowledge_block).unwrap_or_default();
    format!("{item_block}{knowledge_block}{style_block}{extra}{task}")
}

pub fn build_multi_draft_prompt(
    items: &[ItemSummary],
    profile: Option<&ProfileSummary>,
    reference: Option<&ReferenceAccountSummary>,
    extra_instructions: &str,
    knowledge: Option<&LocalContentKnowledgeContext>,
) -> String {
    let mut items_block = "## 物品清单（本次创作涉及的物品，需整合到同一篇笔记中）\n".to_string();
    for (index, item) in items.iter().enumerate() {
        let analysis = item
            .analysis_raw
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or(Value::Null);
        let selling_points = strings(analysis.get("xhs_selling_points"));
        let pairing = analysis
            .get("pairing_suggestions")
            .and_then(Value::as_str)
            .unwrap_or("");
        items_block.push_str(&format!(
            "\n### 物品 {}：{}\n- 风格：{}  材质：{}  颜色：{}\n- 适用场景：{}\n",
            index + 1,
            item.title,
            item.style.as_deref().unwrap_or("—"),
            item.material.as_deref().unwrap_or("—"),
            item.color.as_deref().unwrap_or("—"),
            item.scene.as_deref().unwrap_or("—"),
        ));
        if !item.tags.is_empty() {
            items_block.push_str(&format!("- 标签：{}\n", item.tags.join("、")));
        }
        if !selling_points.is_empty() {
            items_block.push_str(&format!("- 卖点：{}\n", selling_points.join("  /  ")));
        }
        if !pairing.is_empty() {
            items_block.push_str(&format!("- 搭配建议：{pairing}\n"));
        }
    }

    let style_block = reference.map(reference_style_block).unwrap_or_else(|| {
        if profile.is_none() {
            format!("\n{DEFAULT_STYLE}")
        } else {
            String::new()
        }
    });
    let item_names = items
        .iter()
        .map(|item| item.title.as_str())
        .collect::<Vec<_>>()
        .join("、");
    let persona = persona_block(profile);
    let task = format!(
        r#"
{persona}

{CONTENT_GUIDE}

## 任务
根据上面【{} 件物品】的信息，写一篇把它们整合在一起的小红书家居图文笔记。
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
"#,
        items.len()
    );
    let extra = if extra_instructions.is_empty() {
        String::new()
    } else {
        format!("\n## 补充要求\n{extra_instructions}\n")
    };
    let knowledge_block = knowledge.map(build_knowledge_block).unwrap_or_default();
    format!("{items_block}{knowledge_block}{style_block}{extra}{task}")
}

fn reference_style_block(reference: &ReferenceAccountSummary) -> String {
    let mut style = format!(
        "\n## 参考账号风格（{}）\n",
        reference
            .name
            .as_deref()
            .filter(|name| !name.is_empty())
            .unwrap_or(&reference.account_id)
    );
    if let Some(raw_style) = reference.content_style.as_deref() {
        match serde_json::from_str::<Value>(raw_style) {
            Ok(Value::Object(fields)) => {
                for (key, value) in fields {
                    style.push_str(&format!(
                        "- {key}：{}\n",
                        value
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| value.to_string())
                    ));
                }
            }
            _ => style.push_str(&format!("{raw_style}\n")),
        }
    }
    if !reference.top_notes.is_empty() {
        style.push_str("\n参考账号高赞笔记标题（学习句式，不要照抄）：\n");
        for note in reference.top_notes.iter().take(5) {
            style.push_str(&format!("  - {} （赞 {}）\n", note.title, note.likes));
        }
    }
    style
}

fn build_knowledge_block(knowledge: &LocalContentKnowledgeContext) -> String {
    if knowledge.rules.is_empty()
        && knowledge.my_samples.is_empty()
        && knowledge.reference_samples.is_empty()
        && knowledge.inspirations.is_empty()
    {
        return String::new();
    }
    let mut block = vec!["\n## 经验库上下文（基于历史数据沉淀，创作时请优先参考）".to_string()];
    if !knowledge.rules.is_empty() {
        block.push("\n**互动规律**（来自已发布笔记统计）：".to_string());
        block.extend(
            knowledge
                .rules
                .iter()
                .take(5)
                .map(|rule| format!("  ▸ {rule}")),
        );
    }
    if !knowledge.my_samples.is_empty() {
        block.push("\n**我的高赞笔记参考**（学习自己的语气和结构，不要照抄）：".to_string());
        block.extend(knowledge.my_samples.iter().take(3).map(|sample| {
            let preview = if sample.body_preview.is_empty() {
                String::new()
            } else {
                format!("  ——  {}…", sample.body_preview)
            };
            format!("  ▸ 《{}》（赞 {}）{preview}", sample.title, sample.likes)
        }));
    }
    if !knowledge.reference_samples.is_empty() {
        block.push("\n**榜样笔记参考**（学习对标账号的表达方式）：".to_string());
        block.extend(knowledge.reference_samples.iter().take(3).map(|sample| {
            let preview = if sample.body_preview.is_empty() {
                String::new()
            } else {
                format!("  ——  {}…", sample.body_preview)
            };
            format!(
                "  ▸ [{}]《{}》（赞 {}）{preview}",
                sample.account.as_deref().unwrap_or_default(),
                sample.title,
                sample.likes
            )
        }));
    }
    if !knowledge.inspirations.is_empty() {
        block.push("\n**选题灵感方向**（可结合物品特点使用）：".to_string());
        block.extend(
            knowledge
                .inspirations
                .iter()
                .take(3)
                .map(|inspiration| format!("  ▸ {inspiration}")),
        );
    }
    block.push(String::new());
    block.join("\n")
}

pub fn build_topic_prompt(
    item_titles: &[String],
    reference: Option<&ReferenceAccountSummary>,
    crawl_summary: &str,
    extra_instructions: &str,
) -> String {
    let items = item_titles
        .iter()
        .map(|title| format!("  - {title}"))
        .collect::<Vec<_>>()
        .join("\n");
    let account_block = reference
        .map(|reference| {
            let mut block = format!(
                "\n## 参考账号（{}）\n",
                reference
                    .name
                    .as_deref()
                    .filter(|name| !name.is_empty())
                    .unwrap_or(&reference.account_id)
            );
            if let Some(style) = reference.content_style.as_deref() {
                if let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(style) {
                    let title_style = fields.get("标题风格").and_then(Value::as_str).unwrap_or("");
                    let emotion = fields.get("情绪调性").and_then(Value::as_str).unwrap_or("");
                    block.push_str(&format!("- 风格：{title_style} / {emotion}\n"));
                }
            }
            block.push_str(&format!(
                "- 平均点赞：{}  评论：{}\n",
                legacy_float(reference.avg_likes),
                legacy_float(reference.avg_comments)
            ));
            block
        })
        .unwrap_or_default();
    let crawl_block = if crawl_summary.is_empty() {
        String::new()
    } else {
        format!("\n## 近期爬虫分析摘要（平台热信号）\n{crawl_summary}\n")
    };
    let extra = if extra_instructions.is_empty() {
        String::new()
    } else {
        format!("\n## 补充要求\n{extra_instructions}\n")
    };
    format!(
        r#"
## 图库物品清单（待出内容的原材料）
{items}

{account_block}
{crawl_block}
{TOPIC_GUIDE}

{DEFAULT_PERSONA}

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
{extra}"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use aichihongshu_db::LocalKnowledgeSample;

    fn item(title: &str, tags: Vec<String>, analysis_raw: Option<&str>) -> ItemSummary {
        ItemSummary {
            id: 7,
            title: title.to_string(),
            image_path: "fixture.png".to_string(),
            thumbnail_path: None,
            tags,
            style: Some("原木风".to_string()),
            material: Some("橡木".to_string()),
            scene: Some("客厅".to_string()),
            color: Some("浅棕".to_string()),
            analysis_raw: analysis_raw.map(str::to_string),
            note_count: 0,
            created_at: None,
            image_version: 1,
            content_hash: None,
            metadata_version: 1,
        }
    }

    #[test]
    fn composition_prompts_include_legacy_sections_and_account_knowledge() {
        let item = item(
            "小户型收纳架",
            Vec::new(),
            Some(r#"{"xhs_selling_points":["窄缝也能放"],"pairing_suggestions":"放在沙发边"}"#),
        );
        let knowledge = LocalContentKnowledgeContext {
            rules: vec!["10-20 字标题均赞最高（均赞 120）".to_string()],
            rule_summaries: Vec::new(),
            my_samples: vec![LocalKnowledgeSample {
                title: "我自己的高赞笔记".to_string(),
                body_preview: "先吐槽，再讲实用体验".to_string(),
                likes: 250,
                account: None,
            }],
            reference_samples: vec![LocalKnowledgeSample {
                title: "榜样标题".to_string(),
                body_preview: "参考正文".to_string(),
                likes: 800,
                account: Some("收纳榜样".to_string()),
            }],
            inspirations: vec!["小户型空间改造".to_string()],
        };
        let prompt = build_draft_prompt_with_knowledge(
            &item,
            None,
            None,
            "留出真实体验，不要虚构",
            Some(&knowledge),
        );
        for expected in [
            "## 物品信息（MiniMax 分析结果）",
            "- 标签：—",
            "- 小红书卖点：窄缝也能放",
            "- 搭配建议：放在沙发边",
            "## 经验库上下文（基于历史数据沉淀，创作时请优先参考）",
            "**互动规律**（来自已发布笔记统计）",
            "《我自己的高赞笔记》（赞 250）",
            "[收纳榜样]《榜样标题》（赞 800）",
            "▸ 小户型空间改造",
            "---创作备注---",
            "## 补充要求\n留出真实体验，不要虚构",
        ] {
            assert!(prompt.contains(expected), "prompt missing {expected:?}");
        }
    }

    #[test]
    fn draft_prompt_matches_the_complete_legacy_python_output() {
        let mut fixture_item = item(
            "小户型收纳架",
            vec!["租房".to_string(), "收纳".to_string()],
            Some(
                r#"{"xhs_selling_points":["窄缝也能放", "免打孔"],"pairing_suggestions":"放在沙发边"}"#,
            ),
        );
        fixture_item.style = Some("原木风".to_string());
        fixture_item.material = Some("橡木".to_string());
        fixture_item.scene = Some("客厅".to_string());
        fixture_item.color = Some("浅棕".to_string());

        let prompt = build_draft_prompt(&fixture_item, None, None, "留出真实体验，不要虚构");
        let expected = include_str!("../tests/fixtures/legacy_draft_prompt.txt");
        assert_eq!(prompt, expected);
    }

    #[test]
    fn multi_and_topic_prompts_retain_their_distinct_contracts() {
        let items = vec![
            item("折叠餐桌", vec!["租房".to_string()], None),
            item("靠背椅", vec![], None),
        ];
        let multi = build_multi_draft_prompt(&items, None, None, "", None);
        assert!(multi.contains("【2 件物品】"));
        assert!(multi.contains("涉及物品：折叠餐桌、靠背椅"));
        assert!(multi.contains("不要逐一罗列"));
        assert!(multi.contains("物品 1：折叠餐桌"));
        assert!(!multi.contains(
            "物品 2：靠背椅\n- 风格：原木风  材质：橡木  颜色：浅棕\n- 适用场景：客厅\n- 标签："
        ));

        let topic = build_topic_prompt(&["折叠餐桌".to_string()], None, "", "保留真实数据");
        assert!(topic.contains("## 图库物品清单（待出内容的原材料）"));
        assert!(topic.contains("选题生成框架（来自 xhs-topic-ideation.md）"));
        assert!(topic.contains("输出完 5 条后"));
        assert!(topic.contains("## 补充要求\n保留真实数据"));

        let reference = ReferenceAccountSummary {
            id: 1,
            account_id: "reference-1".to_string(),
            name: Some("收纳榜样".to_string()),
            followers: 0,
            total_likes: 0,
            note_count: 0,
            avg_likes: 20.0,
            avg_comments: 4.0,
            avg_collects: 0.0,
            content_style: Some(r#"{"标题风格":"数字清单","情绪调性":"务实"}"#.to_string()),
            top_notes: Vec::new(),
            raw_data: None,
            crawled_at: None,
            analyzed_at: None,
            insights: None,
            insights_at: None,
        };
        let topic = build_topic_prompt(&["折叠餐桌".to_string()], Some(&reference), "", "");
        assert!(topic.contains(
            "## 参考账号（收纳榜样）\n- 风格：数字清单 / 务实\n- 平均点赞：20.0  评论：4.0"
        ));
    }

    #[test]
    fn topic_prompt_matches_the_complete_legacy_fixture() {
        // Static byte-for-byte output captured from the retired Python builder; tests need no Python runtime.
        let reference = ReferenceAccountSummary {
            id: 1,
            account_id: "reference-1".to_string(),
            name: Some("收纳榜样".to_string()),
            followers: 0,
            total_likes: 0,
            note_count: 0,
            avg_likes: 20.0,
            avg_comments: 4.0,
            avg_collects: 0.0,
            content_style: Some(r#"{"标题风格":"数字清单","情绪调性":"务实"}"#.to_string()),
            top_notes: Vec::new(),
            raw_data: None,
            crawled_at: None,
            analyzed_at: None,
            insights: None,
            insights_at: None,
        };
        let prompt = build_topic_prompt(
            &[
                "折叠餐桌（原木风·客厅）".to_string(),
                "收纳架（简约·卧室）".to_string(),
            ],
            Some(&reference),
            "高频钩子词：收纳(12)\nTOP笔记标题：\n  - 标题甲",
            "保留真实数据",
        );
        let expected = include_str!("../tests/fixtures/legacy_topic_prompt.txt");
        assert_eq!(prompt, expected);
    }
}
