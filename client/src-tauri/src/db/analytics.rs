use super::*;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsProfile {
    pub followers: i64,
    pub total_notes: i64,
    pub avg_likes: f64,
    pub avg_comments: f64,
    pub avg_collects: f64,
    pub persona_name: Option<String>,
    pub niche: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsTopNote {
    pub id: i64,
    pub title: Option<String>,
    pub likes: i64,
    pub comments: i64,
    pub collects: i64,
    pub item_title: Option<String>,
    pub note_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsSummary {
    pub item_count: i64,
    pub note_count: i64,
    pub note_status_counts: BTreeMap<String, i64>,
    pub published_avg: [f64; 3],
    pub reference_count: i64,
    pub profile: Option<AnalyticsProfile>,
    pub top_notes: Vec<AnalyticsTopNote>,
    pub items_without_notes: i64,
    pub latest_published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsHour {
    pub hour: u32,
    pub avg_likes: f64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsTag {
    pub tag: String,
    pub count: i64,
    pub avg_likes: f64,
}

#[derive(Debug, Clone)]
pub struct AnalyticsInsights {
    /// (sum of likes, note count) for <10, 10-20, 20-30, and 30+ character titles.
    pub title_buckets: [(i64, i64); 4],
    pub hours: Vec<AnalyticsHour>,
    pub tags: Vec<AnalyticsTag>,
    pub published_avg: [f64; 3],
    pub reference_avg: [f64; 3],
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsTrendDay {
    pub day: String,
    pub count: i64,
    pub total_likes: i64,
}

#[derive(Debug, Clone)]
pub struct AnalyticsTrend {
    pub has_enough_publish_dates: bool,
    pub days: Vec<AnalyticsTrendDay>,
}

#[derive(Debug, Clone, Default)]
pub struct AnalyticsInspireInsights {
    pub best_hours: Vec<u32>,
    pub average_top_title_length: Option<f64>,
    pub top_tags: Vec<String>,
}

impl LocalDb {
    /// Aggregate all active-account rows for the dashboard without the UI snapshot cap.
    pub fn local_analytics_summary(
        &self,
        expected_account_id: Option<i64>,
    ) -> SqlResult<AnalyticsSummary> {
        let conn = self.connect()?;
        let active = ensure_active_account(&conn, &self.path)?;
        ensure_expected_account(&active, expected_account_id)?;
        let account_id = active.id;

        let item_count = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE account_pool_id = ?1 AND deleted_at IS NULL",
            params![account_id],
            |row| row.get(0),
        )?;
        let note_count = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE account_pool_id = ?1 AND deleted_at IS NULL",
            params![account_id],
            |row| row.get(0),
        )?;
        let mut status_stmt = conn.prepare(
            "SELECT status, COUNT(*) FROM notes
             WHERE account_pool_id = ?1 AND deleted_at IS NULL
             GROUP BY status ORDER BY status",
        )?;
        let note_status_counts = status_stmt
            .query_map(params![account_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<SqlResult<BTreeMap<_, _>>>()?;

        let published_avg = conn.query_row(
            "SELECT COALESCE(AVG(likes), 0), COALESCE(AVG(comments), 0),
                    COALESCE(AVG(collects), 0)
             FROM notes WHERE account_pool_id = ?1 AND status = 'published'
               AND deleted_at IS NULL",
            params![account_id],
            |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?]),
        )?;
        let reference_count = conn.query_row(
            "SELECT COUNT(*) FROM reference_accounts WHERE account_pool_id = ?1",
            params![account_id],
            |row| row.get(0),
        )?;
        let profile = conn
            .query_row(
                "SELECT followers, total_notes, avg_likes, avg_comments, avg_collects,
                        persona_name, niche, display_name
                 FROM my_profile WHERE account_pool_id = ?1 ORDER BY id LIMIT 1",
                params![account_id],
                |row| {
                    Ok(AnalyticsProfile {
                        followers: row.get(0)?,
                        total_notes: row.get(1)?,
                        avg_likes: row.get(2)?,
                        avg_comments: row.get(3)?,
                        avg_collects: row.get(4)?,
                        persona_name: row.get(5)?,
                        niche: row.get(6)?,
                        display_name: row.get(7)?,
                    })
                },
            )
            .optional()?;
        let mut top_stmt = conn.prepare(
            "SELECT n.id, n.title, n.likes, n.comments, n.collects, i.title, n.note_url
             FROM notes n
             LEFT JOIN items i ON i.id = n.item_id AND i.account_pool_id = n.account_pool_id
               AND i.deleted_at IS NULL
             WHERE n.account_pool_id = ?1 AND n.status = 'published' AND n.deleted_at IS NULL
             ORDER BY n.likes DESC LIMIT 10",
        )?;
        let top_notes = top_stmt
            .query_map(params![account_id], |row| {
                Ok(AnalyticsTopNote {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    likes: row.get(2)?,
                    comments: row.get(3)?,
                    collects: row.get(4)?,
                    item_title: row.get(5)?,
                    note_url: row.get(6)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        let items_without_notes = conn.query_row(
            "SELECT COUNT(*) FROM items i
             WHERE i.account_pool_id = ?1 AND i.deleted_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM notes n WHERE n.item_id = i.id
                   AND n.account_pool_id = i.account_pool_id AND n.deleted_at IS NULL
               )",
            params![account_id],
            |row| row.get(0),
        )?;
        let latest_published_at = conn.query_row(
            "SELECT MAX(published_at) FROM notes
             WHERE account_pool_id = ?1 AND status = 'published'
               AND published_at IS NOT NULL AND deleted_at IS NULL",
            params![account_id],
            |row| row.get(0),
        )?;

        Ok(AnalyticsSummary {
            item_count,
            note_count,
            note_status_counts,
            published_avg,
            reference_count,
            profile,
            top_notes,
            items_without_notes,
            latest_published_at,
        })
    }

    /// Compute exact all-time insights while retaining only grouped values in memory.
    pub fn local_analytics_insights(
        &self,
        expected_account_id: Option<i64>,
    ) -> SqlResult<AnalyticsInsights> {
        let conn = self.connect()?;
        let active = ensure_active_account(&conn, &self.path)?;
        ensure_expected_account(&active, expected_account_id)?;
        let account_id = active.id;

        let title_buckets = conn.query_row(
            "SELECT
               COALESCE(SUM(CASE WHEN length(title) < 10 THEN COALESCE(likes, 0) END), 0),
               COUNT(CASE WHEN length(title) < 10 THEN 1 END),
               COALESCE(SUM(CASE WHEN length(title) >= 10 AND length(title) < 20 THEN COALESCE(likes, 0) END), 0),
               COUNT(CASE WHEN length(title) >= 10 AND length(title) < 20 THEN 1 END),
               COALESCE(SUM(CASE WHEN length(title) >= 20 AND length(title) < 30 THEN COALESCE(likes, 0) END), 0),
               COUNT(CASE WHEN length(title) >= 20 AND length(title) < 30 THEN 1 END),
               COALESCE(SUM(CASE WHEN length(title) >= 30 THEN COALESCE(likes, 0) END), 0),
               COUNT(CASE WHEN length(title) >= 30 THEN 1 END)
             FROM notes WHERE account_pool_id = ?1 AND status = 'published'
               AND title IS NOT NULL AND deleted_at IS NULL",
            params![account_id],
            |row| {
                Ok([
                    (row.get(0)?, row.get(1)?),
                    (row.get(2)?, row.get(3)?),
                    (row.get(4)?, row.get(5)?),
                    (row.get(6)?, row.get(7)?),
                ])
            },
        )?;
        let mut hour_stmt = conn.prepare(
            "SELECT CAST(strftime('%H', published_at) AS INTEGER),
                    ROUND(AVG(COALESCE(likes, 0)), 1), COUNT(*)
             FROM notes WHERE account_pool_id = ?1 AND status = 'published'
               AND published_at IS NOT NULL AND deleted_at IS NULL
               AND strftime('%H', published_at) IS NOT NULL
             GROUP BY strftime('%H', published_at) ORDER BY strftime('%H', published_at)",
        )?;
        let hours = hour_stmt
            .query_map(params![account_id], |row| {
                Ok(AnalyticsHour {
                    hour: row.get::<_, i64>(0)? as u32,
                    avg_likes: row.get(1)?,
                    count: row.get(2)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        let mut tag_stats = HashMap::<String, (i64, i64)>::new();
        {
            let mut tag_stmt = conn.prepare(
                "SELECT tags, COALESCE(likes, 0) FROM notes
                 WHERE account_pool_id = ?1 AND status = 'published'
                   AND tags IS NOT NULL AND deleted_at IS NULL",
            )?;
            let mut rows = tag_stmt.query(params![account_id])?;
            while let Some(row) = rows.next()? {
                let tags = parse_json_vec::<String>(row.get(0)?);
                let likes: i64 = row.get(1)?;
                for tag in tags {
                    let stats = tag_stats.entry(tag).or_default();
                    stats.0 += 1;
                    stats.1 += likes;
                }
            }
        }
        let mut tags = tag_stats.into_iter().collect::<Vec<_>>();
        tags.sort_by(|(left, (left_count, _)), (right, (right_count, _))| {
            right_count.cmp(left_count).then_with(|| left.cmp(right))
        });
        let tags = tags
            .into_iter()
            .take(20)
            .map(|(tag, (count, total_likes))| AnalyticsTag {
                tag,
                count,
                avg_likes: round_one(total_likes as f64 / count as f64),
            })
            .collect();

        let published_avg = conn.query_row(
            "SELECT COALESCE(AVG(likes), 0), COALESCE(AVG(comments), 0),
                    COALESCE(AVG(collects), 0)
             FROM notes WHERE account_pool_id = ?1 AND status = 'published'
               AND deleted_at IS NULL",
            params![account_id],
            |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?]),
        )?;
        let reference_avg = conn.query_row(
            "SELECT COALESCE(AVG(avg_likes), 0), COALESCE(AVG(avg_comments), 0),
                    COALESCE(AVG(avg_collects), 0)
             FROM reference_accounts WHERE account_pool_id = ?1",
            params![account_id],
            |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?]),
        )?;

        Ok(AnalyticsInsights {
            title_buckets,
            hours,
            tags,
            published_avg,
            reference_avg,
        })
    }

    /// Aggregate the selected 90-day trend window without loading note bodies or history.
    pub fn local_analytics_trend(
        &self,
        expected_account_id: Option<i64>,
    ) -> SqlResult<AnalyticsTrend> {
        let conn = self.connect()?;
        let active = ensure_active_account(&conn, &self.path)?;
        ensure_expected_account(&active, expected_account_id)?;
        let account_id = active.id;
        let published_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE account_pool_id = ?1 AND status = 'published'
               AND published_at IS NOT NULL AND deleted_at IS NULL",
            params![account_id],
            |row| row.get(0),
        )?;
        let has_enough_publish_dates = published_count >= 3;
        let (date_expression, where_clause) = if has_enough_publish_dates {
            (
                "date(published_at)",
                "status = 'published' AND published_at IS NOT NULL",
            )
        } else {
            ("date(created_at)", "1 = 1")
        };
        let sql = format!(
            "SELECT {date_expression} AS day, COUNT(*), COALESCE(SUM(likes), 0)
             FROM notes WHERE account_pool_id = ?1 AND deleted_at IS NULL
               AND {where_clause}
               AND {date_expression} >= date('now', '-90 days')
             GROUP BY day ORDER BY day"
        );
        let mut stmt = conn.prepare(&sql)?;
        let days = stmt
            .query_map(params![account_id], |row| {
                Ok(AnalyticsTrendDay {
                    day: row.get(0)?,
                    count: row.get(1)?,
                    total_likes: row.get(2)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(AnalyticsTrend {
            has_enough_publish_dates,
            days,
        })
    }

    /// Read the compact all-time signals injected into the legacy inspiration prompt.
    pub fn local_analytics_inspire_insights(
        &self,
        expected_account_id: Option<i64>,
    ) -> SqlResult<AnalyticsInspireInsights> {
        let conn = self.connect()?;
        let active = ensure_active_account(&conn, &self.path)?;
        ensure_expected_account(&active, expected_account_id)?;
        let account_id = active.id;

        let mut hour_stmt = conn.prepare(
            "SELECT CAST(strftime('%H', published_at) AS INTEGER), AVG(likes), COUNT(*)
             FROM notes WHERE account_pool_id = ?1 AND status = 'published'
               AND published_at IS NOT NULL AND deleted_at IS NULL
               AND strftime('%H', published_at) IS NOT NULL
             GROUP BY strftime('%H', published_at)",
        )?;
        let mut best_hours = hour_stmt
            .query_map(params![account_id], |row| {
                Ok((row.get::<_, i64>(0)? as u32, row.get::<_, f64>(1)?))
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        best_hours.sort_by(|left, right| {
            right
                .1
                .total_cmp(&left.1)
                .then_with(|| left.0.cmp(&right.0))
        });
        let best_hours = best_hours
            .into_iter()
            .take(3)
            .map(|(hour, _)| hour)
            .collect();

        let title_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes
             WHERE account_pool_id = ?1 AND status = 'published'
               AND title IS NOT NULL AND likes > 0 AND deleted_at IS NULL",
            params![account_id],
            |row| row.get(0),
        )?;
        let average_top_title_length = if title_count >= 3 {
            let top_count = title_count / 3;
            conn.query_row(
                "SELECT AVG(length(title)) FROM (
                    SELECT title FROM notes
                    WHERE account_pool_id = ?1 AND status = 'published'
                      AND title IS NOT NULL AND likes > 0 AND deleted_at IS NULL
                    ORDER BY likes DESC LIMIT ?2
                 )",
                params![account_id, top_count],
                |row| row.get(0),
            )?
        } else {
            None
        };

        let mut tag_stats = Vec::<(String, i64, i64)>::new();
        let mut tag_positions = HashMap::<String, usize>::new();
        {
            let mut tag_stmt = conn.prepare(
                "SELECT tags, COALESCE(likes, 0) FROM notes
                 WHERE account_pool_id = ?1 AND status = 'published'
                   AND tags IS NOT NULL AND deleted_at IS NULL
                 ORDER BY id ASC",
            )?;
            let mut rows = tag_stmt.query(params![account_id])?;
            while let Some(row) = rows.next()? {
                let tags = parse_json_vec::<String>(row.get(0)?);
                let likes: i64 = row.get(1)?;
                for tag in tags {
                    let index = match tag_positions.get(&tag) {
                        Some(index) => *index,
                        None => {
                            let index = tag_stats.len();
                            tag_positions.insert(tag.clone(), index);
                            tag_stats.push((tag, 0, 0));
                            index
                        }
                    };
                    tag_stats[index].1 += 1;
                    tag_stats[index].2 += likes;
                }
            }
        }
        let mut tags = tag_stats
            .into_iter()
            .map(|(tag, count, total_likes)| (tag, total_likes as f64 / count.max(1) as f64))
            .collect::<Vec<_>>();
        // Python's stable sort retained first-seen order when average likes tied.
        tags.sort_by(|left, right| right.1.total_cmp(&left.1));
        let top_tags = tags.into_iter().take(5).map(|(tag, _)| tag).collect();

        Ok(AnalyticsInspireInsights {
            best_hours,
            average_top_title_length,
            top_tags,
        })
    }
}

fn round_one(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}
