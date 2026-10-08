use super::*;

impl LocalDb {
    #[cfg(test)]
    pub(super) fn snapshot(&self) -> SqlResult<WorkspaceSnapshot> {
        self.snapshot_for_account(None)
    }

    #[cfg(test)]
    pub(super) fn snapshot_for_account(
        &self,
        expected_account_id: Option<i64>,
    ) -> SqlResult<WorkspaceSnapshot> {
        self.snapshot_section_for_account(expected_account_id, "all")
    }

    /// Read only the data needed by a UI resource. Existing callers keep the full snapshot.
    pub fn snapshot_section_for_account(
        &self,
        expected_account_id: Option<i64>,
        section: &str,
    ) -> SqlResult<WorkspaceSnapshot> {
        let with_items = matches!(section, "all" | "workspace" | "library" | "notes");
        let with_notes = matches!(section, "all" | "workspace" | "notes");
        let with_references = matches!(section, "all" | "workspace" | "references");
        let conn = self.connect()?;
        let active = ensure_active_account(&conn, &self.path)?;
        ensure_expected_account(&active, expected_account_id)?;

        let profile = conn
            .query_row(
                "SELECT id, account_pool_id, account_id, display_name, niche, target_audience,
                        content_pillars, persona_name, persona_bio, persona_tone, persona_taboos,
                        followers, total_notes, total_likes, total_collects,
                        avg_likes, avg_comments, avg_collects,
                        preferred_styles, preferred_scenes, hashtag_pool, posting_rhythm,
                        avatar_url, xhs_bio, xhs_follows, ip_location, xhs_tags,
                        risk_warning_ack, risk_warning_ack_at, crawled_at, created_at, updated_at
                 FROM my_profile
                 WHERE account_pool_id = ?1
                 ORDER BY id
                 LIMIT 1",
                params![active.id],
                |row| {
                    Ok(ProfileSummary {
                        id: row.get(0)?,
                        account_pool_id: row.get(1)?,
                        account_id: row.get(2)?,
                        display_name: row.get(3)?,
                        niche: row.get(4)?,
                        target_audience: row.get(5)?,
                        content_pillars: parse_json_vec(row.get(6)?),
                        persona_name: row.get(7)?,
                        persona_bio: row.get(8)?,
                        persona_tone: row.get(9)?,
                        persona_taboos: parse_json_vec(row.get(10)?),
                        followers: row.get(11)?,
                        total_notes: row.get(12)?,
                        total_likes: row.get(13)?,
                        total_collects: row.get(14)?,
                        avg_likes: row.get(15)?,
                        avg_comments: row.get(16)?,
                        avg_collects: row.get(17)?,
                        preferred_styles: parse_json_vec(row.get(18)?),
                        preferred_scenes: parse_json_vec(row.get(19)?),
                        hashtag_pool: parse_json_vec(row.get(20)?),
                        posting_rhythm: row.get(21)?,
                        avatar_url: row.get(22)?,
                        xhs_bio: row.get(23)?,
                        xhs_follows: row.get(24)?,
                        ip_location: row.get(25)?,
                        xhs_tags: parse_json_vec(row.get(26)?),
                        risk_warning_ack: row.get(27)?,
                        risk_warning_ack_at: row.get(28)?,
                        crawled_at: row.get(29)?,
                        created_at: row.get(30)?,
                        updated_at: row.get(31)?,
                    })
                },
            )
            .optional()?;

        let item_count: i64 = conn.query_row(
            if section == "analytics" {
                "SELECT COUNT(*) FROM items WHERE account_pool_id = ?1"
            } else {
                "SELECT COUNT(*) FROM items
                 WHERE account_pool_id = ?1 AND deleted_at IS NULL"
            },
            params![active.id],
            |row| row.get(0),
        )?;
        let note_count: i64 = conn.query_row(
            if section == "analytics" {
                "SELECT COUNT(*) FROM notes WHERE account_pool_id = ?1"
            } else {
                "SELECT COUNT(*) FROM notes
                 WHERE account_pool_id = ?1 AND deleted_at IS NULL"
            },
            params![active.id],
            |row| row.get(0),
        )?;
        let note_status_counts = {
            let mut status_stmt = conn.prepare(if section == "analytics" {
                "SELECT status, COUNT(*) FROM notes
                     WHERE account_pool_id = ?1
                     GROUP BY status
                     ORDER BY status"
            } else {
                "SELECT status, COUNT(*) FROM notes
                     WHERE account_pool_id = ?1 AND deleted_at IS NULL
                     GROUP BY status
                     ORDER BY status"
            })?;
            let status_rows = status_stmt.query_map(params![active.id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            let mut counts = BTreeMap::new();
            for row in status_rows {
                let (status, count) = row?;
                counts.insert(status, count);
            }
            counts
        };

        let items = if with_items {
            read_item_summaries(&conn, active.id, false)?
        } else {
            Vec::new()
        };
        let trash_items = if matches!(section, "all" | "library") {
            read_item_summaries(&conn, active.id, true)?
        } else {
            Vec::new()
        };
        let missing_image_ids = if matches!(section, "all" | "library") {
            items
                .iter()
                .chain(trash_items.iter())
                .filter(|item| !self.resolve_image_path(&item.image_path).is_file())
                .map(|item| item.id)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let notes = if with_notes {
            read_note_summaries(&conn, active.id, false)?
        } else {
            Vec::new()
        };
        let trash_notes = if matches!(section, "all" | "notes") {
            read_note_summaries(&conn, active.id, true)?
        } else {
            Vec::new()
        };

        let mut ref_stmt = conn.prepare(
            "SELECT id, account_id, name, followers, total_likes, note_count,
                    avg_likes, avg_comments, avg_collects, content_style, top_notes,
                    raw_data, crawled_at, analyzed_at, insights, insights_at
             FROM reference_accounts
             WHERE account_pool_id = ?1
             ORDER BY id DESC",
        )?;
        let reference_accounts = if with_references {
            ref_stmt
                .query_map(params![active.id], |row| {
                    Ok(ReferenceAccountSummary {
                        id: row.get(0)?,
                        account_id: row.get(1)?,
                        name: row.get(2)?,
                        followers: row.get(3)?,
                        total_likes: row.get(4)?,
                        note_count: row.get(5)?,
                        avg_likes: row.get(6)?,
                        avg_comments: row.get(7)?,
                        avg_collects: row.get(8)?,
                        content_style: row.get(9)?,
                        top_notes: parse_json_vec(row.get(10)?),
                        raw_data: row.get(11)?,
                        crawled_at: row.get(12)?,
                        analyzed_at: row.get(13)?,
                        insights: row.get(14)?,
                        insights_at: row.get(15)?,
                    })
                })?
                .collect::<SqlResult<Vec<_>>>()?
        } else {
            Vec::new()
        };

        Ok(WorkspaceSnapshot {
            database_path: self.path.display().to_string(),
            active_account: active,
            profile,
            item_count,
            items,
            trash_items,
            missing_image_ids,
            note_count,
            note_status_counts,
            notes,
            trash_notes,
            reference_accounts,
        })
    }
}
