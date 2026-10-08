use super::*;

/// Phone-owned full snapshot. IDs returned are cache addresses, never phone content.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobilePromptSnapshot {
    pub account_id: i64,
    pub prompts: Vec<MobilePromptSnapshotItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobilePromptSnapshotItem {
    local_id: i64,
    remote_id: Option<i64>,
    title: String,
    content: String,
    enabled: bool,
    apply_scope: String,
    apply_target: String,
    sort_order: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePromptSnapshotResult {
    mappings: Vec<MobilePromptMapping>,
    deleted_prompts: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobilePromptMapping {
    local_id: i64,
    remote_id: i64,
}

impl LocalDb {
    /// Validate the final snapshot quota, then replace only this account's mobile
    /// prompt cache in one transaction. Stale cache rows never consume the quota.
    pub fn replace_mobile_prompt_snapshot(
        &self,
        snapshot: MobilePromptSnapshot,
    ) -> Result<MobilePromptSnapshotResult, String> {
        let mut local_ids = std::collections::HashSet::new();
        let mut remote_ids = std::collections::HashSet::new();
        for prompt in &snapshot.prompts {
            validate_experience_prompt_fields(&prompt.title, &prompt.content)?;
            if prompt.local_id <= 0 || !local_ids.insert(prompt.local_id) {
                return Err("手机经验 ID 无效或重复".into());
            }
            if let Some(id) = prompt.remote_id {
                if id <= 0 || !remote_ids.insert(id) {
                    return Err("手机经验缓存 ID 无效或重复".into());
                }
            }
            if !matches!(prompt.apply_scope.as_str(), "global" | "account")
                || !matches!(prompt.apply_target.as_str(), "all" | "compose" | "chat")
            {
                return Err("经验适用范围或场景无效".into());
            }
        }
        if snapshot.prompts.iter().filter(|p| p.enabled).count() > 10 {
            return Err("手机启用中的写作经验最多 10 条；本次未更新电脑缓存".into());
        }
        let mut conn = self.connect().map_err(|e| e.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let active = ensure_active_account(&tx, &self.path).map_err(|e| e.to_string())?;
        ensure_expected_account(&active, Some(snapshot.account_id)).map_err(|e| e.to_string())?;
        let old_ids = {
            let mut stmt = tx.prepare(
                "SELECT id FROM experience_prompts WHERE account_pool_id = ?1 AND origin = 'mobile'",
            ).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([active.id], |row| row.get::<_, i64>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let mut retained = std::collections::HashSet::new();
        let mut mappings = Vec::new();
        for prompt in snapshot.prompts {
            let mut existing = None;
            if let Some(id) = prompt.remote_id {
                let owner: Option<(i64, String)> = tx
                    .query_row(
                        "SELECT account_pool_id, origin FROM experience_prompts WHERE id = ?1",
                        [id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if let Some((account_id, origin)) = owner {
                    if account_id != active.id || origin != "mobile" {
                        return Err("经验缓存不属于当前账号的手机池".into());
                    }
                    existing = Some(id);
                }
            }
            let id = if let Some(id) = existing {
                tx.execute(
                    "UPDATE experience_prompts SET title=?1, content=?2, enabled=?3,
                     apply_scope=?4, apply_target=?5, sort_order=?6, source='user',
                     updated_at=datetime('now', 'localtime') WHERE id=?7",
                    params![
                        prompt.title.trim(),
                        prompt.content.trim(),
                        prompt.enabled,
                        prompt.apply_scope,
                        prompt.apply_target,
                        prompt.sort_order,
                        id
                    ],
                )
                .map_err(|e| e.to_string())?;
                id
            } else {
                tx.execute(
                    "INSERT INTO experience_prompts
                     (account_pool_id,origin,title,content,enabled,apply_scope,apply_target,source,sort_order)
                     VALUES (?1,'mobile',?2,?3,?4,?5,?6,'user',?7)",
                    params![active.id, prompt.title.trim(), prompt.content.trim(), prompt.enabled,
                        prompt.apply_scope, prompt.apply_target, prompt.sort_order],
                ).map_err(|e| e.to_string())?;
                tx.last_insert_rowid()
            };
            retained.insert(id);
            mappings.push(MobilePromptMapping {
                local_id: prompt.local_id,
                remote_id: id,
            });
        }
        let mut deleted_prompts = 0;
        for id in old_ids {
            if !retained.contains(&id) {
                deleted_prompts += tx.execute(
                    "DELETE FROM experience_prompts WHERE id=?1 AND account_pool_id=?2 AND origin='mobile'",
                    params![id, active.id],
                ).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(MobilePromptSnapshotResult {
            mappings,
            deleted_prompts,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_db() -> (LocalDb, PathBuf) {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("mobile-snapshot-{}-{nonce}", std::process::id()));
        (LocalDb::open(dir.join("app.db")).unwrap(), dir)
    }

    fn snapshot(count: usize) -> MobilePromptSnapshot {
        serde_json::from_value(json!({
            "accountId": 1,
            "prompts": (1..=count).map(|id| json!({
                "localId": id, "remoteId": null, "title": format!("经验{id}"),
                "content": "具体写作经验", "enabled": true, "applyScope": "account",
                "applyTarget": "all", "sortOrder": id
            })).collect::<Vec<_>>()
        }))
        .unwrap()
    }

    #[test]
    fn mobile_snapshot_replaces_full_quota_and_rolls_back_invalid_owner() {
        let (db, dir) = temp_db();
        let pc = db
            .upsert_experience_prompt_with_id(ExperiencePromptUpsert {
                account_pool_id: 1,
                origin: "pc".into(),
                id: None,
                title: "PC独有".into(),
                content: "不可删除".into(),
                enabled: true,
                apply_scope: None,
                apply_target: None,
                source: None,
                sort_order: None,
            })
            .unwrap()
            .0;
        db.replace_mobile_prompt_snapshot(snapshot(10)).unwrap();
        let seven = db.replace_mobile_prompt_snapshot(snapshot(7)).unwrap();
        assert_eq!(seven.deleted_prompts, 10);
        assert_eq!(seven.mappings.len(), 7);
        let before = serde_json::to_value(
            db.list_experience_prompts(Some(1), Some("mobile".into()))
                .unwrap(),
        )
        .unwrap();
        assert!(db.replace_mobile_prompt_snapshot(snapshot(11)).is_err());
        let mut bad = snapshot(2);
        // First item is inserted before the second item's ownership check fails.
        bad.prompts[1].remote_id = Some(pc);
        assert!(db.replace_mobile_prompt_snapshot(bad).is_err());
        assert_eq!(
            serde_json::to_value(
                db.list_experience_prompts(Some(1), Some("mobile".into()))
                    .unwrap()
            )
            .unwrap(),
            before
        );
        let mut repeat = snapshot(7);
        for (item, mapping) in repeat.prompts.iter_mut().zip(&seven.mappings) {
            item.remote_id = Some(mapping.remote_id);
        }
        let result = db.replace_mobile_prompt_snapshot(repeat).unwrap();
        assert_eq!(result.deleted_prompts, 0);
        assert_eq!(result.mappings[0].remote_id, seven.mappings[0].remote_id);
        let empty = db.replace_mobile_prompt_snapshot(snapshot(0)).unwrap();
        assert_eq!(empty.deleted_prompts, 7);
        assert_eq!(
            db.list_experience_prompts(Some(1), Some("pc".into()))
                .unwrap()[0]
                .id,
            pc
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn mobile_snapshot_rejects_bad_fields_duplicates_and_changed_account() {
        let (db, dir) = temp_db();
        db.replace_mobile_prompt_snapshot(snapshot(1)).unwrap();
        let mut duplicate = snapshot(2);
        duplicate.prompts[1].local_id = 1;
        assert!(db.replace_mobile_prompt_snapshot(duplicate).is_err());
        let mut invalid = snapshot(1);
        invalid.prompts[0].content = "😀".repeat(5001);
        assert!(db.replace_mobile_prompt_snapshot(invalid).is_err());
        let second = db
            .create_local_account(LocalAccountCreate {
                alias: "其他账号".into(),
                role: "operation".into(),
                notes: None,
            })
            .unwrap();
        db.activate_account(second).unwrap();
        assert!(db.replace_mobile_prompt_snapshot(snapshot(0)).is_err());
        db.activate_account(1).unwrap();
        assert_eq!(
            db.list_experience_prompts(Some(1), Some("mobile".into()))
                .unwrap()
                .len(),
            1
        );
        std::fs::remove_dir_all(dir).ok();
    }
}
