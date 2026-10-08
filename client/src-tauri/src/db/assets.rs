use super::*;
use rusqlite::Row;

fn read_mcp_item(row: &Row<'_>) -> SqlResult<McpItemSummary> {
    Ok(McpItemSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        image_path: row.get(2)?,
        style: row.get(3)?,
        material: row.get(4)?,
        scene: row.get(5)?,
        color: row.get(6)?,
        tags: parse_json_vec(row.get(7)?),
        analysis_raw: row.get(8)?,
        note_count: row.get(9)?,
        account_pool_id: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn items_have_updated_at(conn: &Connection) -> SqlResult<bool> {
    let mut statement = conn.prepare("PRAGMA table_info(items)")?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == "updated_at" {
            return Ok(true);
        }
    }
    Ok(false)
}

impl LocalDb {
    /// Read one active-account item for CLI operations without loading a workspace snapshot.
    pub fn get_local_item_for_cli(
        &self,
        item_id: i64,
    ) -> Result<(i64, Option<ItemSummary>), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        let item = conn
            .query_row(
                "SELECT id, title, image_path, thumbnail_path, tags, style, material, scene, color,
                        analysis_raw, note_count, created_at, image_version, content_hash, metadata_version
                 FROM items
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![item_id, active.id],
                item_summary_from_row,
            )
            .optional()
            .map_err(|error| format!("读取图库素材失败: {error}"))?;
        Ok((active.id, item))
    }

    /// Query the legacy CLI trash list by deletion time without the UI snapshot cap.
    pub fn list_local_trashed_items_for_cli(&self) -> Result<Vec<ItemSummary>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        let mut statement = conn
            .prepare(
                "SELECT id, title, image_path, thumbnail_path, tags, style, material, scene, color,
                        analysis_raw, note_count, created_at, image_version, content_hash, metadata_version
                 FROM items
                 WHERE account_pool_id = ?1 AND deleted_at IS NOT NULL
                 ORDER BY deleted_at DESC",
            )
            .map_err(|error| format!("查询回收站失败: {error}"))?;
        let rows = statement
            .query_map(params![active.id], item_summary_from_row)
            .map_err(|error| format!("读取回收站失败: {error}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("读取回收站失败: {error}"))
    }

    /// Query the legacy CLI library list with its SQL `LIKE`, order, and default page size.
    pub fn list_local_items_for_cli(
        &self,
        tag: Option<&str>,
        style: Option<&str>,
    ) -> Result<Vec<ItemSummary>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        let tag_pattern = tag
            .filter(|value| !value.is_empty())
            .map(|value| format!("%\"{value}\"%"));
        let style_pattern = style
            .filter(|value| !value.is_empty())
            .map(|value| format!("%{value}%"));
        let mut statement = conn
            .prepare(
                "SELECT id, title, image_path, thumbnail_path, tags, style, material, scene, color,
                        analysis_raw, note_count, created_at, image_version, content_hash, metadata_version
                 FROM items
                 WHERE account_pool_id = ?1 AND deleted_at IS NULL
                   AND (?2 IS NULL OR tags LIKE ?2)
                   AND (?3 IS NULL OR style LIKE ?3)
                 ORDER BY created_at DESC
                 LIMIT 50",
            )
            .map_err(|error| format!("查询图库素材失败: {error}"))?;
        let rows = statement
            .query_map(params![active.id, tag_pattern, style_pattern], |row| {
                Ok(ItemSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    image_path: row.get(2)?,
                    thumbnail_path: row.get(3)?,
                    tags: parse_json_vec(row.get(4)?),
                    style: row.get(5)?,
                    material: row.get(6)?,
                    scene: row.get(7)?,
                    color: row.get(8)?,
                    analysis_raw: row.get(9)?,
                    note_count: row.get(10)?,
                    created_at: row.get(11)?,
                    image_version: row.get(12)?,
                    content_hash: row.get(13)?,
                    metadata_version: row.get(14)?,
                })
            })
            .map_err(|error| format!("读取图库素材失败: {error}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("读取图库素材失败: {error}"))
    }

    /// Query the legacy MCP library page directly, preserving its filters, order, and page size.
    pub fn list_local_items_for_mcp(
        &self,
        tag: Option<&str>,
        style: Option<&str>,
    ) -> Result<Vec<McpItemSummary>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        let tag_pattern = tag
            .filter(|value| !value.is_empty())
            .map(|value| format!("%\"{value}\"%"));
        let style_pattern = style
            .filter(|value| !value.is_empty())
            .map(|value| format!("%{value}%"));
        let updated_at_column = if items_have_updated_at(&conn)
            .map_err(|error| format!("读取图库字段失败: {error}"))?
        {
            "updated_at"
        } else {
            "NULL"
        };
        let sql = format!(
            "SELECT id, title, image_path, style, material, scene, color, tags, analysis_raw,
                    note_count, account_pool_id, created_at, {updated_at_column}
             FROM items
             WHERE account_pool_id = ?1 AND deleted_at IS NULL
               AND (?2 IS NULL OR tags LIKE ?2)
               AND (?3 IS NULL OR style LIKE ?3)
             ORDER BY created_at DESC
             LIMIT 50"
        );
        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| format!("查询图库素材失败: {error}"))?;
        let rows = statement
            .query_map(
                params![active.id, tag_pattern, style_pattern],
                read_mcp_item,
            )
            .map_err(|error| format!("读取图库素材失败: {error}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("读取图库素材失败: {error}"))
    }

    pub fn get_local_item_for_mcp(&self, item_id: i64) -> Result<Option<McpItemSummary>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        let updated_at_column = if items_have_updated_at(&conn)
            .map_err(|error| format!("读取图库字段失败: {error}"))?
        {
            "updated_at"
        } else {
            "NULL"
        };
        let sql = format!(
            "SELECT id, title, image_path, style, material, scene, color, tags, analysis_raw,
                    note_count, account_pool_id, created_at, {updated_at_column}
             FROM items
             WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL"
        );
        conn.query_row(&sql, params![item_id, active.id], read_mcp_item)
            .optional()
            .map_err(|error| format!("读取图库素材失败: {error}"))
    }

    /// 读取当前运营账号可见物品的本地图片，返回 data URL 供桌面 WebView 展示。
    /// 图片路径来自受账号隔离约束的 items 记录，不接受前端任意文件路径。
    #[cfg(test)]
    pub(super) fn image_data_url(&self, item_id: i64) -> Result<Option<String>, String> {
        self.image_data_url_for_account(item_id, None, "original")
    }

    pub fn image_data_url_for_account(
        &self,
        item_id: i64,
        expected_account_id: Option<i64>,
        variant: &str,
    ) -> Result<Option<String>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let stored_paths: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT image_path, thumbnail_path FROM items
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![item_id, active.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("读取图片记录失败: {error}"))?;

        let Some((original_path, thumbnail_path)) = stored_paths else {
            return Ok(None);
        };
        let image_path = if variant == "thumbnail" {
            thumbnail_path
                .as_deref()
                .map(|path| self.resolve_image_path(path))
                .filter(|path| path.is_file())
                .unwrap_or_else(|| self.resolve_image_path(&original_path))
        } else {
            self.resolve_image_path(&original_path)
        };
        let bytes = fs::read(&image_path)
            .map_err(|error| format!("读取图片失败（{}）: {error}", image_path.display()))?;
        let extension = image_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime = match extension.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "svg" => "image/svg+xml",
            _ => "application/octet-stream",
        };
        Ok(Some(format!(
            "data:{mime};base64,{}",
            STANDARD.encode(bytes)
        )))
    }

    pub(super) fn resolve_image_path(&self, stored_path: &str) -> PathBuf {
        let path = PathBuf::from(stored_path);
        if path.is_absolute() {
            return path;
        }

        let db_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let project_root = db_dir.parent().unwrap_or(db_dir);
        let candidates = [
            db_dir.join(&path),
            project_root.join(&path),
            project_root.join("assets").join(&path),
            db_dir.join("assets").join(&path),
        ];
        candidates
            .iter()
            .find(|candidate| candidate.is_file())
            .cloned()
            .unwrap_or_else(|| project_root.join("assets").join(path))
    }

    /// 将前端已读取的图片安全写入当前账号素材目录，并在数据库提交失败时清理文件。
    /// 前端不传任意路径；文件名只用于推断类型和标题，落位路径由内容摘要生成。
    pub fn import_local_image(&self, import: LocalImageImport) -> Result<ItemSummary, String> {
        let account_pool_id = import.account_pool_id;
        self.import_local_image_for_account(account_pool_id, import)
    }

    /// 按显式账号导入素材（PC Harness 等宿主侧链路）。不依赖 UI 激活账号，
    /// 但要求目标账号存在，保证任务创建时冻结的账号归属不被切换干扰。
    pub fn import_local_image_for_account(
        &self,
        account_pool_id: i64,
        import: LocalImageImport,
    ) -> Result<ItemSummary, String> {
        let file_name = import.file_name.trim();
        let path = Path::new(file_name);
        let validated = validate_local_image(&import)?;
        let thumbnail_bytes = validate_thumbnail(import.thumbnail_data_base64.as_deref())?;
        let extension = validated.extension.as_str();
        let bytes = validated.bytes.as_slice();
        let hash = validated.hash.as_str();

        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let account_exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM account_pool WHERE id = ?1",
                params![account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("校验导入账号失败: {error}"))?;
        if account_exists.is_none() {
            return Err("导入账号不存在".to_string());
        }

        if let Some(existing) = read_item_by_hash(&conn, account_pool_id, hash)
            .map_err(|error| format!("检查重复素材失败: {error}"))?
        {
            return Ok(existing);
        }

        let db_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let relative_path = format!("assets/{}/{hash}.{extension}", account_pool_id);
        let target_path = db_dir.join(&relative_path);
        let thumbnail_relative_path = thumbnail_bytes
            .as_ref()
            .map(|_| format!("assets/{}/thumbnails/{hash}.jpg", account_pool_id));
        let thumbnail_target_path = thumbnail_relative_path
            .as_deref()
            .map(|relative| db_dir.join(relative));
        let parent = target_path
            .parent()
            .ok_or_else(|| "无法定位素材目录".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建素材目录失败: {error}"))?;

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let staging_path = parent.join(format!(".import-{}-{stamp}.staging", std::process::id()));
        {
            let mut staging = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging_path)
                .map_err(|error| format!("创建素材暂存文件失败: {error}"))?;
            if let Err(error) = staging.write_all(bytes) {
                fs::remove_file(&staging_path).ok();
                return Err(format!("写入素材暂存文件失败: {error}"));
            }
            if let Err(error) = staging.sync_all() {
                fs::remove_file(&staging_path).ok();
                return Err(format!("刷新素材暂存文件失败: {error}"));
            }
        }

        if let Err(error) = fs::rename(&staging_path, &target_path) {
            fs::remove_file(&staging_path).ok();
            return Err(format!("素材落位失败: {error}"));
        }

        if let (Some(thumbnail_bytes), Some(thumbnail_target_path)) =
            (thumbnail_bytes.as_ref(), thumbnail_target_path.as_ref())
        {
            let thumbnail_parent = thumbnail_target_path
                .parent()
                .ok_or_else(|| "无法定位缩略图目录".to_string())?;
            if let Err(error) = fs::create_dir_all(thumbnail_parent) {
                fs::remove_file(&target_path).ok();
                return Err(format!("创建缩略图目录失败: {error}"));
            }
            let thumbnail_staging_path = thumbnail_parent.join(format!(
                ".import-thumbnail-{}-{stamp}.staging",
                std::process::id()
            ));
            let mut staging = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&thumbnail_staging_path)
            {
                Ok(staging) => staging,
                Err(error) => {
                    fs::remove_file(&target_path).ok();
                    return Err(format!("创建缩略图暂存文件失败: {error}"));
                }
            };
            if let Err(error) = staging.write_all(thumbnail_bytes) {
                fs::remove_file(&thumbnail_staging_path).ok();
                fs::remove_file(&target_path).ok();
                return Err(format!("写入缩略图暂存文件失败: {error}"));
            }
            if let Err(error) = staging.sync_all() {
                fs::remove_file(&thumbnail_staging_path).ok();
                fs::remove_file(&target_path).ok();
                return Err(format!("刷新缩略图暂存文件失败: {error}"));
            }
            if let Err(error) = fs::rename(&thumbnail_staging_path, thumbnail_target_path) {
                fs::remove_file(&thumbnail_staging_path).ok();
                fs::remove_file(&target_path).ok();
                return Err(format!("缩略图落位失败: {error}"));
            }
        }

        let title = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("未命名素材")
            .trim();
        let title = if title.is_empty() {
            "未命名素材"
        } else {
            title
        };
        let tx = match conn.transaction() {
            Ok(tx) => tx,
            Err(error) => {
                fs::remove_file(&target_path).ok();
                if let Some(path) = thumbnail_target_path.as_ref() {
                    fs::remove_file(path).ok();
                }
                return Err(format!("开始素材保存事务失败: {error}"));
            }
        };
        let insert_result = tx.execute(
            "INSERT INTO items (title, image_path, thumbnail_path, tags, account_pool_id, image_version, content_hash, metadata_version)
             VALUES (?1, ?2, ?3, '[]', ?4, 1, ?5, 1)",
            params![
                title,
                relative_path,
                thumbnail_relative_path,
                account_pool_id,
                hash
            ],
        );
        if let Err(error) = insert_result {
            fs::remove_file(&target_path).ok();
            if let Some(path) = thumbnail_target_path.as_ref() {
                fs::remove_file(path).ok();
            }
            return Err(format!("保存素材记录失败: {error}"));
        }
        let item_id = tx.last_insert_rowid();
        let item = match read_item_summary(&tx, item_id, account_pool_id) {
            Ok(item) => item,
            Err(error) => {
                fs::remove_file(&target_path).ok();
                if let Some(path) = thumbnail_target_path.as_ref() {
                    fs::remove_file(path).ok();
                }
                return Err(format!("读取已保存素材失败: {error}"));
            }
        };
        if let Err(error) = tx.commit() {
            fs::remove_file(&target_path).ok();
            if let Some(path) = thumbnail_target_path.as_ref() {
                fs::remove_file(path).ok();
            }
            return Err(format!("提交素材记录失败: {error}"));
        }
        Ok(item)
    }

    /// 用用户明确选择的新文件修复/替换当前账号素材；旧文件保留，避免误删仍被其他记录引用的路径。
    /// 图片内容版本递增并清空旧分析结果，缓存会因新版本键自然失效。
    pub fn repair_local_image(&self, repair: LocalImageRepair) -> Result<ItemSummary, String> {
        let validated = validate_local_image(&LocalImageImport {
            account_pool_id: repair.account_pool_id,
            file_name: repair.file_name.clone(),
            mime_type: repair.mime_type.clone(),
            data_base64: repair.data_base64,
            thumbnail_data_base64: None,
        })?;
        let thumbnail_bytes = validate_thumbnail(repair.thumbnail_data_base64.as_deref())?;
        let extension = validated.extension.as_str();
        let bytes = validated.bytes.as_slice();
        let hash = validated.hash.as_str();

        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(repair.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let current: Option<(String, i64, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT image_path, image_version, content_hash, thumbnail_path FROM items
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![repair.item_id, active.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| format!("读取待修复素材失败: {error}"))?;
        let Some((current_path, current_version, current_hash, current_thumbnail_path)) = current
        else {
            return Err("素材不存在或不属于当前账号".to_string());
        };
        if current_version != repair.expected_image_version {
            return Err(format!(
                "素材图片版本冲突：当前为 {current_version}，修复请求为 {}，请刷新后重试",
                repair.expected_image_version
            ));
        }
        if current_hash.as_deref() == Some(hash) {
            let thumbnail_ready = thumbnail_bytes
                .as_ref()
                .map(|_| {
                    current_thumbnail_path
                        .as_deref()
                        .map(|path| self.resolve_image_path(path).is_file())
                        .unwrap_or(false)
                })
                .unwrap_or(true);
            if self.resolve_image_path(&current_path).is_file() && thumbnail_ready {
                return read_item_summary(&conn, repair.item_id, active.id)
                    .map_err(|error| format!("读取已存在素材失败: {error}"));
            }
        }
        let duplicate_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM items
                 WHERE account_pool_id = ?1 AND content_hash = ?2 AND id <> ?3 AND deleted_at IS NULL
                 ORDER BY id LIMIT 1",
                params![active.id, hash, repair.item_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("检查重复修复素材失败: {error}"))?;
        if let Some(existing_id) = duplicate_id {
            return Err(format!(
                "该图片内容已存在于素材 {existing_id}，未覆盖当前素材"
            ));
        }

        let db_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let relative_path = format!("assets/{}/{hash}.{extension}", active.id);
        let target_path = db_dir.join(&relative_path);
        let thumbnail_relative_path = thumbnail_bytes
            .as_ref()
            .map(|_| format!("assets/{}/thumbnails/{hash}.jpg", active.id));
        let thumbnail_target_path = thumbnail_relative_path
            .as_deref()
            .map(|relative| db_dir.join(relative));
        let parent = target_path
            .parent()
            .ok_or_else(|| "无法定位素材目录".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建素材目录失败: {error}"))?;
        let target_exists = target_path.is_file();
        if target_exists {
            let existing_bytes = fs::read(&target_path)
                .map_err(|error| format!("读取已有素材目标文件失败: {error}"))?;
            if existing_bytes.as_slice() != bytes {
                return Err("素材目标文件已存在但内容摘要不匹配，未覆盖".to_string());
            }
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let staging_path = parent.join(format!(".repair-{}-{stamp}.staging", std::process::id()));
        let mut thumbnail_target_created = false;
        if !target_exists {
            let mut staging = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging_path)
                .map_err(|error| format!("创建素材修复暂存文件失败: {error}"))?;
            if let Err(error) = staging.write_all(bytes) {
                fs::remove_file(&staging_path).ok();
                return Err(format!("写入素材修复暂存文件失败: {error}"));
            }
            if let Err(error) = staging.sync_all() {
                fs::remove_file(&staging_path).ok();
                return Err(format!("刷新素材修复暂存文件失败: {error}"));
            }
            if let Err(error) = fs::rename(&staging_path, &target_path) {
                fs::remove_file(&staging_path).ok();
                return Err(format!("素材修复落位失败: {error}"));
            }
        }

        if let (Some(thumbnail_bytes), Some(thumbnail_target_path)) =
            (thumbnail_bytes.as_ref(), thumbnail_target_path.as_ref())
        {
            let thumbnail_parent = thumbnail_target_path
                .parent()
                .ok_or_else(|| "无法定位缩略图目录".to_string())?;
            fs::create_dir_all(thumbnail_parent)
                .map_err(|error| format!("创建缩略图目录失败: {error}"))?;
            let thumbnail_exists = thumbnail_target_path.is_file();
            if thumbnail_exists {
                let existing_bytes = fs::read(thumbnail_target_path)
                    .map_err(|error| format!("读取已有缩略图失败: {error}"))?;
                if existing_bytes.as_slice() != thumbnail_bytes {
                    return Err("缩略图目标文件已存在但内容不匹配，未覆盖".to_string());
                }
            } else {
                let thumbnail_staging_path = thumbnail_parent.join(format!(
                    ".repair-thumbnail-{}-{stamp}.staging",
                    std::process::id()
                ));
                let mut staging = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&thumbnail_staging_path)
                    .map_err(|error| format!("创建缩略图修复暂存文件失败: {error}"))?;
                if let Err(error) = staging.write_all(thumbnail_bytes) {
                    fs::remove_file(&thumbnail_staging_path).ok();
                    if !target_exists {
                        fs::remove_file(&target_path).ok();
                    }
                    return Err(format!("写入缩略图修复暂存文件失败: {error}"));
                }
                if let Err(error) = staging.sync_all() {
                    fs::remove_file(&thumbnail_staging_path).ok();
                    if !target_exists {
                        fs::remove_file(&target_path).ok();
                    }
                    return Err(format!("刷新缩略图修复暂存文件失败: {error}"));
                }
                if let Err(error) = fs::rename(&thumbnail_staging_path, thumbnail_target_path) {
                    fs::remove_file(&thumbnail_staging_path).ok();
                    if !target_exists {
                        fs::remove_file(&target_path).ok();
                    }
                    return Err(format!("缩略图修复落位失败: {error}"));
                }
                thumbnail_target_created = true;
            }
        }

        let tx = match conn.transaction() {
            Ok(tx) => tx,
            Err(error) => {
                if !target_exists {
                    fs::remove_file(&target_path).ok();
                }
                if thumbnail_target_created {
                    if let Some(path) = thumbnail_target_path.as_ref() {
                        fs::remove_file(path).ok();
                    }
                }
                return Err(format!("开始素材修复事务失败: {error}"));
            }
        };
        let changed = tx
            .execute(
                "UPDATE items SET image_path = ?1, thumbnail_path = ?2,
                        image_version = image_version + 1, content_hash = ?3, analysis_raw = NULL
                 WHERE id = ?4 AND account_pool_id = ?5 AND deleted_at IS NULL
                   AND image_version = ?6",
                params![
                    relative_path,
                    thumbnail_relative_path,
                    hash,
                    repair.item_id,
                    active.id,
                    repair.expected_image_version,
                ],
            )
            .map_err(|error| format!("保存修复素材记录失败: {error}"))?;
        if changed != 1 {
            if !target_exists {
                fs::remove_file(&target_path).ok();
            }
            if thumbnail_target_created {
                if let Some(path) = thumbnail_target_path.as_ref() {
                    fs::remove_file(path).ok();
                }
            }
            return Err("素材不存在、账号已切换或图片版本冲突，修复未写入".to_string());
        }
        let item = match read_item_summary(&tx, repair.item_id, active.id) {
            Ok(item) => item,
            Err(error) => {
                if !target_exists {
                    fs::remove_file(&target_path).ok();
                }
                if thumbnail_target_created {
                    if let Some(path) = thumbnail_target_path.as_ref() {
                        fs::remove_file(path).ok();
                    }
                }
                return Err(format!("读取已修复素材失败: {error}"));
            }
        };
        if let Err(error) = tx.commit() {
            if !target_exists {
                fs::remove_file(&target_path).ok();
            }
            if thumbnail_target_created {
                if let Some(path) = thumbnail_target_path.as_ref() {
                    fs::remove_file(path).ok();
                }
            }
            return Err(format!("提交素材修复失败: {error}"));
        }
        Ok(item)
    }

    /// 软删除当前账号素材；数据库记录和磁盘文件保留，供回收站恢复或后续清理。
    pub fn delete_local_item(&self, item_id: i64, account_pool_id: i64) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = conn
            .execute(
                "UPDATE items SET deleted_at = datetime('now', 'localtime')
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![item_id, active.id],
            )
            .map_err(|error| format!("删除本地素材失败: {error}"))?;
        if changed != 1 {
            return Err("素材不存在、已删除或不属于当前账号".to_string());
        }
        Ok(())
    }

    /// 从当前账号回收站恢复素材；若相同内容已有活动素材则拒绝恢复以免重复。
    pub fn restore_local_item(
        &self,
        item_id: i64,
        account_pool_id: i64,
    ) -> Result<ItemSummary, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let hash: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM items
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NOT NULL",
                params![item_id, active.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取回收站素材失败: {error}"))?;
        if let Some(hash) = hash {
            if let Some(existing_id) = conn
                .query_row(
                    "SELECT id FROM items
                     WHERE account_pool_id = ?1 AND content_hash = ?2 AND deleted_at IS NULL
                       AND id <> ?3 LIMIT 1",
                    params![active.id, hash, item_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| format!("检查恢复重复素材失败: {error}"))?
            {
                return Err(format!("相同内容的活动素材 {existing_id} 已存在，未恢复"));
            }
        }
        let changed = conn
            .execute(
                "UPDATE items SET deleted_at = NULL
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NOT NULL",
                params![item_id, active.id],
            )
            .map_err(|error| format!("恢复本地素材失败: {error}"))?;
        if changed != 1 {
            return Err("素材已被其他操作恢复或删除，未写入".to_string());
        }
        read_item_summary(&conn, item_id, active.id)
            .map_err(|error| format!("读取已恢复素材失败: {error}"))
    }

    /// 永久清理当前账号回收站素材。仍被任何本地笔记引用的素材必须先解除引用，
    /// 且只删除由本地图库管理的 assets 路径；数据库失败会恢复已暂存文件。
    pub fn purge_local_items(
        &self,
        item_ids: &[i64],
        account_pool_id: i64,
    ) -> Result<PurgeItemsResult, String> {
        let mut unique_ids = Vec::new();
        let mut seen = HashSet::new();
        for id in item_ids {
            if *id > 0 && seen.insert(*id) {
                unique_ids.push(*id);
            }
        }
        if unique_ids.is_empty() {
            return Err("至少选择一项回收站素材".to_string());
        }
        if unique_ids.len() > 100 {
            return Err("单次最多永久清理 100 项素材".to_string());
        }

        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始素材永久清理事务失败: {error}"))?;

        let mut records = Vec::with_capacity(unique_ids.len());
        for item_id in &unique_ids {
            let record: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT image_path, thumbnail_path FROM items
                     WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NOT NULL",
                    params![item_id, active.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| format!("读取回收站素材失败: {error}"))?;
            let Some(record) = record else {
                return Err(format!("素材 {item_id} 不在当前账号回收站，未清理"));
            };
            records.push((*item_id, record.0, record.1));
        }

        let selected: HashSet<i64> = unique_ids.iter().copied().collect();
        let mut referenced = HashSet::new();
        let mut note_stmt = tx
            .prepare("SELECT item_id, item_ids FROM notes WHERE account_pool_id = ?1")
            .map_err(|error| format!("读取笔记素材关联失败: {error}"))?;
        let note_rows = note_stmt
            .query_map(params![active.id], |row| {
                let primary: Option<i64> = row.get(0)?;
                let item_ids_json: Option<String> = row.get(1)?;
                Ok((primary, parse_json_vec::<i64>(item_ids_json)))
            })
            .map_err(|error| format!("扫描笔记素材关联失败: {error}"))?;
        for row in note_rows {
            let (primary, item_ids) =
                row.map_err(|error| format!("读取笔记素材关联失败: {error}"))?;
            if let Some(item_id) = primary {
                if selected.contains(&item_id) {
                    referenced.insert(item_id);
                }
            }
            for item_id in item_ids {
                if selected.contains(&item_id) {
                    referenced.insert(item_id);
                }
            }
        }
        drop(note_stmt);
        if !referenced.is_empty() {
            let mut ids = referenced.into_iter().collect::<Vec<_>>();
            ids.sort_unstable();
            return Err(format!(
                "素材仍被笔记引用（{}），请先删除笔记或解除素材关联后再永久清理",
                ids.iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }

        let selected_paths: HashSet<String> = records
            .iter()
            .flat_map(|(_, image_path, thumbnail_path)| {
                std::iter::once(image_path.clone()).chain(thumbnail_path.clone())
            })
            .collect();
        let mut staged = Vec::<(PathBuf, PathBuf)>::new();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        for (item_id, image_path, thumbnail_path) in &records {
            for stored_path in std::iter::once(image_path).chain(thumbnail_path.as_ref()) {
                if !self.is_managed_asset_path(&self.resolve_image_path(stored_path)) {
                    return Err(format!(
                        "素材 {item_id} 的文件路径不在本地 assets 管理范围，未清理"
                    ));
                }
                let resolved = self.resolve_image_path(stored_path);
                if !resolved.is_file() {
                    continue;
                }
                if staged.iter().any(|(source, _)| source == &resolved) {
                    continue;
                }
                let mut shared = false;
                let mut ref_stmt = tx
                    .prepare(
                        "SELECT id, image_path, thumbnail_path FROM items
                         WHERE image_path = ?1 OR thumbnail_path = ?1",
                    )
                    .map_err(|error| format!("检查素材文件引用失败: {error}"))?;
                let refs = ref_stmt
                    .query_map(params![stored_path], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    })
                    .map_err(|error| format!("检查素材文件引用失败: {error}"))?;
                for reference in refs {
                    let (reference_id, reference_image, reference_thumbnail) =
                        reference.map_err(|error| format!("读取素材文件引用失败: {error}"))?;
                    if !selected.contains(&reference_id)
                        || !selected_paths.contains(&reference_image)
                        || reference_thumbnail
                            .as_deref()
                            .is_some_and(|path| !selected_paths.contains(path))
                    {
                        shared = true;
                        break;
                    }
                }
                drop(ref_stmt);
                if shared {
                    continue;
                }
                let parent = resolved
                    .parent()
                    .ok_or_else(|| format!("素材 {item_id} 文件目录无效"))?;
                let staged_path =
                    parent.join(format!(".purge-{item_id}-{}-{stamp}.staging", staged.len()));
                if staged_path.exists() {
                    return Err("素材永久清理暂存文件已存在，未清理".to_string());
                }
                if let Err(error) = fs::rename(&resolved, &staged_path) {
                    for (source, staging) in staged.iter().rev() {
                        fs::rename(staging, source).ok();
                    }
                    return Err(format!("暂存待清理素材失败: {error}"));
                }
                staged.push((resolved, staged_path));
            }
        }

        for item_id in &unique_ids {
            let changed = tx
                .execute(
                    "DELETE FROM items
                     WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NOT NULL",
                    params![item_id, active.id],
                )
                .map_err(|error| format!("删除素材记录失败: {error}"))?;
            if changed != 1 {
                for (source, staging) in staged.iter().rev() {
                    fs::rename(staging, source).ok();
                }
                return Err(format!("素材 {item_id} 已被其他操作改变，未清理"));
            }
        }
        if let Err(error) = tx.commit() {
            for (source, staging) in staged.iter().rev() {
                fs::rename(staging, source).ok();
            }
            return Err(format!("提交素材永久清理失败: {error}"));
        }

        let mut cleanup_warnings = Vec::new();
        for (source, staging) in staged {
            if let Err(error) = fs::remove_file(&staging) {
                cleanup_warnings.push(format!(
                    "{}（原路径 {}）: {error}",
                    staging.display(),
                    source.display()
                ));
            }
        }
        Ok(PurgeItemsResult {
            purged_ids: unique_ids,
            cleanup_warnings,
        })
    }

    fn is_managed_asset_path(&self, path: &Path) -> bool {
        let db_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let project_root = db_dir.parent().unwrap_or(db_dir);
        path.starts_with(db_dir.join("assets")) || path.starts_with(project_root.join("assets"))
    }

    /// 更新当前账号素材元数据；图片内容版本保持不变，独立 metadata_version 防止旧回执覆盖。
    pub fn update_local_item_metadata(
        &self,
        update: LocalItemMetadataUpdate,
    ) -> Result<ItemSummary, String> {
        let title = update.title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err("素材标题必须是 1 到 200 个字符".to_string());
        }
        if update.tags.len() > 30 || update.tags.iter().any(|tag| tag.chars().count() > 40) {
            return Err("素材标签数量或长度超出限制".to_string());
        }
        let tags = serde_json::to_string(&update.tags)
            .map_err(|error| format!("序列化素材标签失败: {error}"))?;
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(update.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始素材元数据保存失败: {error}"))?;
        let updated_at_set = if items_have_updated_at(&tx)
            .map_err(|error| format!("读取图库字段失败: {error}"))?
        {
            ", updated_at = datetime('now','localtime')"
        } else {
            ""
        };
        let sql = format!(
            "UPDATE items SET title = ?1, tags = ?2, style = ?3, material = ?4,
                    scene = ?5, color = ?6, metadata_version = metadata_version + 1{updated_at_set}
             WHERE id = ?7 AND account_pool_id = ?8 AND deleted_at IS NULL
               AND metadata_version = ?9"
        );
        let changed = tx
            .execute(
                &sql,
                params![
                    title,
                    tags,
                    update.style,
                    update.material,
                    update.scene,
                    update.color,
                    update.item_id,
                    active.id,
                    update.expected_metadata_version,
                ],
            )
            .map_err(|error| format!("保存素材元数据失败: {error}"))?;
        if changed != 1 {
            return Err("素材不存在、账号已切换或元数据版本冲突，保存未写入".to_string());
        }
        let item = read_item_summary(&tx, update.item_id, active.id)
            .map_err(|error| format!("读取已保存素材元数据失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交素材元数据失败: {error}"))?;
        Ok(item)
    }

    /// 保存图片模型分析结果。回执绑定素材图片版本，避免分析期间素材被替换后旧结果覆盖新图。
    pub fn update_local_item_analysis(
        &self,
        item_id: i64,
        account_pool_id: i64,
        expected_image_version: i64,
        analysis: &serde_json::Value,
        title_policy: LocalItemAnalysisTitlePolicy,
    ) -> Result<ItemSummary, String> {
        let analysis = match analysis {
            serde_json::Value::Object(_) => analysis.clone(),
            value => serde_json::json!({
                "raw_text": value.to_string(),
                "parse_error": true,
            }),
        };
        let title_from_analysis = analysis
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty() && title.chars().count() <= 200);
        let field = |name: &str| {
            analysis
                .get(name)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let tags = analysis
            .get("tags")
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|tag| !tag.is_empty() && tag.chars().count() <= 40)
                    .take(30)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let tags =
            serde_json::to_string(&tags).map_err(|error| format!("序列化分析标签失败: {error}"))?;
        let analysis_raw = serde_json::to_string(&analysis)
            .map_err(|error| format!("序列化图片分析结果失败: {error}"))?;

        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始图片分析保存事务失败: {error}"))?;
        let (current_title, metadata_version): (String, i64) = tx
            .query_row(
                "SELECT title, metadata_version FROM items
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL
                   AND image_version = ?3",
                params![item_id, active.id, expected_image_version],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("检查图片分析目标失败: {error}"))?
            .ok_or_else(|| "素材不存在、账号已切换或图片版本已变化，分析结果未写入".to_string())?;
        let title_is_default = current_title.starts_with("tmp")
            || (current_title.is_ascii()
                && !current_title.contains(' ')
                && current_title.len() < 20);
        let title = match title_policy {
            LocalItemAnalysisTitlePolicy::Force => title_from_analysis.unwrap_or(&current_title),
            LocalItemAnalysisTitlePolicy::IfDefault if title_is_default => {
                title_from_analysis.unwrap_or(&current_title)
            }
            LocalItemAnalysisTitlePolicy::IfDefault | LocalItemAnalysisTitlePolicy::Preserve => {
                &current_title
            }
        };
        let changed = tx
            .execute(
                "UPDATE items SET title = ?1, style = ?2, material = ?3, scene = ?4,
                        color = ?5, tags = ?6, analysis_raw = ?7,
                        metadata_version = metadata_version + 1
                 WHERE id = ?8 AND account_pool_id = ?9 AND deleted_at IS NULL
                   AND image_version = ?10 AND metadata_version = ?11",
                params![
                    title,
                    field("style"),
                    field("material"),
                    field("scene"),
                    field("color"),
                    tags,
                    analysis_raw,
                    item_id,
                    active.id,
                    expected_image_version,
                    metadata_version,
                ],
            )
            .map_err(|error| format!("保存图片分析结果失败: {error}"))?;
        if changed != 1 {
            return Err("素材元数据或图片版本已变化，分析结果未写入".to_string());
        }
        let item = read_item_summary(&tx, item_id, active.id)
            .map_err(|error| format!("读取图片分析结果失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交图片分析结果失败: {error}"))?;
        Ok(item)
    }
}
