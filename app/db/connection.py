# -*- coding: utf-8 -*-
"""SQLite 连接管理（单例）"""

import os
import shutil
import sqlite3
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

_PROJECT_ROOT = Path(__file__).parent.parent.parent
_DB_PATH = _PROJECT_ROOT / os.getenv("DB_PATH", "data/app.db")

# v0.2 新增：账号池浏览器目录根（可通过 .env 覆盖）
BROWSER_PROFILES_ROOT = _PROJECT_ROOT / os.getenv(
    "BROWSER_PROFILES_DIR", "data/browser_profiles"
)
# 老用户登录态目录（升级时自动迁移到主号）
_LEGACY_USER_DATA_DIR = _PROJECT_ROOT / "tools" / "MediaCrawler" / "browser_data" / "xhs_user_data_dir"


def get_db() -> sqlite3.Connection:
    """获取数据库连接，自动建库建表"""
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """初始化数据库，执行建表 SQL，并自动补充新列（迁移）"""
    from app.db.schema import SCHEMA_SQL
    conn = get_db()
    conn.executescript(SCHEMA_SQL)
    conn.commit()

    # 迁移：为 my_profile 补充新列（已存在时忽略）
    _MIGRATIONS = [
        "ALTER TABLE my_profile ADD COLUMN avatar_url TEXT",
        "ALTER TABLE my_profile ADD COLUMN xhs_bio TEXT",
        "ALTER TABLE my_profile ADD COLUMN xhs_follows INTEGER DEFAULT 0",
        "ALTER TABLE my_profile ADD COLUMN ip_location TEXT",
        "ALTER TABLE my_profile ADD COLUMN xhs_tags TEXT DEFAULT '[]'",
        "ALTER TABLE my_profile ADD COLUMN crawled_at TEXT",
        "ALTER TABLE items ADD COLUMN deleted_at TEXT",
        "ALTER TABLE notes ADD COLUMN item_ids TEXT DEFAULT '[]'",
        # 经验库：高赞样本标记
        "ALTER TABLE notes ADD COLUMN use_as_reference INTEGER DEFAULT 0",
        # 经验库：榜样笔记样本（含正文）
        "ALTER TABLE reference_accounts ADD COLUMN ref_notes TEXT DEFAULT '[]'",
        # 笔记类型：text（文字配图）| image（图文多图）| video（视频）
        "ALTER TABLE notes ADD COLUMN note_type TEXT DEFAULT 'text'",
        # 视频路径（video 类型时使用）
        "ALTER TABLE notes ADD COLUMN video_path TEXT",
        # ── v0.2 主号保护 + 账号池 ──
        "ALTER TABLE my_profile ADD COLUMN account_pool_id INTEGER",
        "ALTER TABLE my_profile ADD COLUMN protection_mode INTEGER DEFAULT 0",
        "ALTER TABLE my_profile ADD COLUMN risk_warning_ack INTEGER DEFAULT 0",
        "ALTER TABLE my_profile ADD COLUMN risk_warning_ack_at TEXT",
        # ── v0.3 多账号隔离 ──
        "ALTER TABLE notes ADD COLUMN account_pool_id INTEGER",
        "ALTER TABLE items ADD COLUMN account_pool_id INTEGER",
    ]

    # 经验库：选题灵感表（CREATE TABLE IF NOT EXISTS 幂等）
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS inspirations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT NOT NULL,
            keyword     TEXT,
            source      TEXT DEFAULT 'ai',
            likes_ref   INTEGER DEFAULT 0,
            note_ref    TEXT,
            saved       INTEGER DEFAULT 1,
            created_at  TEXT DEFAULT (datetime('now', 'localtime'))
        );
    """)
    for sql in _MIGRATIONS:
        try:
            conn.execute(sql)
            conn.commit()
        except Exception:
            pass  # 列已存在，忽略

    # 初始化默认快捷操作 prompt（首次启动时写入）
    _DEFAULT_PROMPTS = [
        ("quick_title",   "生成标题",   "请为这篇笔记生成 5 个吸引人的标题，每行一个，格式：\n1. 标题一\n2. 标题二\n…\n不超过 20 字，带情绪词或反问，避免营销腔。", 0),
        ("quick_body",    "优化正文",   "请帮我优化这篇笔记的正文，保持口语化，短句换行，突出卖点，控制在 300 字以内。", 1),
        ("quick_tags",    "生成标签",   "请为这篇笔记生成 8 个小红书话题标签，格式：\n#标签1 #标签2 …\n贴合内容垂类，覆盖主话题/场景/风格/情绪四类。", 2),
        ("quick_cover",   "写封面文案", "请为这篇笔记写一段封面图文字，不超过 15 字，大字报风格，有视觉冲击力。", 3),
    ]
    for key, label, prompt, order in _DEFAULT_PROMPTS:
        conn.execute(
            """INSERT OR IGNORE INTO prompt_configs (key, label, prompt, sort_order)
               VALUES (?, ?, ?, ?)""",
            (key, label, prompt, order),
        )
    conn.commit()

    # ── v0.2 自动迁移：账号池初始化 + 老用户登录态迁移 ─────────────────────
    _bootstrap_account_pool(conn)

    # ── v0.3 自动迁移：角色重命名 + 多账号数据归属 ─────────────────────────
    _migrate_v03_account_roles(conn)

    conn.close()
    print(f"[db] 数据库已初始化：{_DB_PATH}")


def _bootstrap_account_pool(conn: sqlite3.Connection) -> None:
    """首次升级到 v0.2 时：
    1. 若 account_pool 为空，创建一条主号记录
    2. 把 tools/MediaCrawler/browser_data/xhs_user_data_dir 拷贝到
       data/browser_profiles/main/，原目录改名为 .backup（保留备份）
    3. 把 active_account_id 写入 app_settings
    4. 把现有 my_profile.account_pool_id 关联到这条主号记录
    """
    # 已存在数据则跳过
    row = conn.execute("SELECT COUNT(*) AS c FROM account_pool").fetchone()
    if row and row["c"] > 0:
        return

    BROWSER_PROFILES_ROOT.mkdir(parents=True, exist_ok=True)
    main_dir = BROWSER_PROFILES_ROOT / "main"

    # 老用户登录态自动迁移：优先用 rename（同盘瞬时完成），失败再降级到 copytree
    migrated = False
    if _LEGACY_USER_DATA_DIR.exists() and not main_dir.exists():
        try:
            # 先在原地创建符号链接备份指向（非破坏性），然后 rename 真目录
            backup = _LEGACY_USER_DATA_DIR.parent / (_LEGACY_USER_DATA_DIR.name + ".backup")
            if backup.exists():
                shutil.rmtree(backup, ignore_errors=True)
            # rename 在同一文件系统下是 O(1) 操作；跨盘会抛 OSError
            try:
                _LEGACY_USER_DATA_DIR.rename(main_dir)
                # 在原位留一个空目录占位（避免老脚本误以为登录态丢失）
                _LEGACY_USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
                # 在 main 下软链回去做备份记号（占用 0 空间）
                (BROWSER_PROFILES_ROOT / ".legacy_migrated").write_text(
                    str(_LEGACY_USER_DATA_DIR), encoding="utf-8"
                )
                migrated = True
                print(f"[db] 已迁移登录态：{_LEGACY_USER_DATA_DIR} → {main_dir}（rename）")
            except OSError:
                # 跨盘场景：退回拷贝（耗时但兼容）
                print(f"[db] rename 失败，使用 copytree 迁移登录态（可能耗时较长）...")
                shutil.copytree(_LEGACY_USER_DATA_DIR, main_dir)
                shutil.move(str(_LEGACY_USER_DATA_DIR), str(backup))
                _LEGACY_USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
                migrated = True
                print(f"[db] 已迁移登录态（copy）：→ {main_dir}，原目录备份为 .backup")
        except Exception as e:
            print(f"[db] ⚠ 登录态迁移失败（将创建空目录）：{e}")
            main_dir.mkdir(parents=True, exist_ok=True)
    else:
        main_dir.mkdir(parents=True, exist_ok=True)

    # 读取 my_profile 中已有的昵称/粉丝数，继承到 account_pool
    profile_row = conn.execute(
        "SELECT account_id, display_name, followers FROM my_profile WHERE id=1"
    ).fetchone()

    cur = conn.execute(
        """INSERT INTO account_pool
           (alias, role, user_data_dir, xhs_user_id, display_name, followers, status)
           VALUES (?, 'main', ?, ?, ?, ?, 'active')""",
        (
            "主号",
            str(main_dir),
            profile_row["account_id"] if profile_row else None,
            profile_row["display_name"] if profile_row else None,
            profile_row["followers"] if profile_row else 0,
        ),
    )
    conn.commit()
    main_id = cur.lastrowid

    # 把 my_profile 关联到主号 + 写入激活账号
    if profile_row:
        conn.execute(
            "UPDATE my_profile SET account_pool_id=? WHERE id=1",
            (main_id,),
        )
    conn.execute(
        """INSERT INTO app_settings (key, value, updated_at)
           VALUES ('active_account_id', ?, datetime('now','localtime'))
           ON CONFLICT(key) DO UPDATE SET
             value=excluded.value, updated_at=excluded.updated_at""",
        (str(main_id),),
    )
    conn.commit()

    if migrated:
        print(f"[db] 账号池已初始化（主号 id={main_id}），原登录态保留为 .backup")
    else:
        print(f"[db] 账号池已初始化（主号 id={main_id}），新建空目录 {main_dir}")


def _migrate_v03_account_roles(conn: sqlite3.Connection) -> None:
    """v0.3 迁移：
    1. account_pool.role 旧值（main/sub_publish/sub_crawl）映射到新值（operation/assistant）
       - main → operation
       - sub_publish → operation
       - sub_crawl → assistant
       因 SQLite CHECK 约束变更需重建表，此处先重建 account_pool。
    2. 把现有 notes/items 全部 backfill account_pool_id = 第一个 operation 账号 id
    3. 兼容老 my_profile 单行模式（id=1）：保留，但 account_pool_id 必须有值
    """
    # 检查是否需要 v0.3 迁移：CHECK 约束里没有 'operation' 视为旧版
    schema_row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='account_pool'"
    ).fetchone()
    if not schema_row:
        return
    if "'operation'" in schema_row["sql"]:
        # 已是 v0.3 schema，仅 backfill 缺失的 account_pool_id
        _backfill_account_pool_id(conn)
        return

    print("[db] v0.3 迁移：account_pool 角色重映射 main→operation, sub_*→operation/assistant")

    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        # 1. 重建 account_pool 表
        conn.executescript("""
            CREATE TABLE account_pool_new (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                alias           TEXT UNIQUE NOT NULL,
                role            TEXT NOT NULL DEFAULT 'operation'
                                CHECK(role IN ('operation','assistant')),
                user_data_dir   TEXT UNIQUE NOT NULL,
                xhs_user_id     TEXT,
                display_name    TEXT,
                followers       INTEGER DEFAULT 0,
                status          TEXT DEFAULT 'active'
                                CHECK(status IN ('active','banned','suspended','retired')),
                ban_count       INTEGER DEFAULT 0,
                last_used_at    TEXT,
                notes           TEXT,
                created_at      TEXT DEFAULT (datetime('now', 'localtime'))
            );
        """)
        # 2. 数据迁移并映射 role
        conn.execute("""
            INSERT INTO account_pool_new
              (id, alias, role, user_data_dir, xhs_user_id, display_name,
               followers, status, ban_count, last_used_at, notes, created_at)
            SELECT id, alias,
                   CASE role
                     WHEN 'main' THEN 'operation'
                     WHEN 'sub_publish' THEN 'operation'
                     WHEN 'sub_crawl' THEN 'assistant'
                     ELSE 'operation'
                   END,
                   user_data_dir, xhs_user_id, display_name,
                   followers, status, ban_count, last_used_at, notes, created_at
            FROM account_pool
        """)
        conn.execute("DROP TABLE account_pool")
        conn.execute("ALTER TABLE account_pool_new RENAME TO account_pool")
        conn.commit()
        print("[db] account_pool 角色已重映射")
    finally:
        conn.execute("PRAGMA foreign_keys=ON")

    # 3. 重建 my_profile 表：id 改 AUTOINCREMENT，account_pool_id 加 UNIQUE
    profile_schema = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='my_profile'"
    ).fetchone()
    if profile_schema and "PRIMARY KEY DEFAULT 1" in profile_schema["sql"]:
        print("[db] v0.3 迁移：my_profile 升级为多行模式")
        conn.execute("PRAGMA foreign_keys=OFF")
        try:
            # 备份现有列名
            cols = [r["name"] for r in conn.execute("PRAGMA table_info(my_profile)").fetchall()]
            cols_str = ", ".join(cols)
            conn.executescript(f"""
                ALTER TABLE my_profile RENAME TO my_profile_old;
                CREATE TABLE my_profile (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_pool_id INTEGER UNIQUE REFERENCES account_pool(id) ON DELETE CASCADE,
                    account_id TEXT,
                    display_name TEXT,
                    niche TEXT,
                    target_audience TEXT,
                    content_pillars TEXT DEFAULT '[]',
                    persona_name TEXT,
                    persona_bio TEXT,
                    persona_tone TEXT,
                    persona_taboos TEXT DEFAULT '[]',
                    followers INTEGER DEFAULT 0,
                    total_notes INTEGER DEFAULT 0,
                    total_likes INTEGER DEFAULT 0,
                    total_collects INTEGER DEFAULT 0,
                    avg_likes REAL DEFAULT 0,
                    avg_comments REAL DEFAULT 0,
                    avg_collects REAL DEFAULT 0,
                    preferred_styles TEXT DEFAULT '[]',
                    preferred_scenes TEXT DEFAULT '[]',
                    hashtag_pool TEXT DEFAULT '[]',
                    posting_rhythm TEXT,
                    avatar_url TEXT,
                    xhs_bio TEXT,
                    xhs_follows INTEGER DEFAULT 0,
                    ip_location TEXT,
                    xhs_tags TEXT DEFAULT '[]',
                    crawled_at TEXT,
                    risk_warning_ack INTEGER DEFAULT 0,
                    risk_warning_ack_at TEXT,
                    created_at TEXT DEFAULT (datetime('now', 'localtime')),
                    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
                );
            """)
            # 把老数据搬过来（共有列）
            keep_cols = [c for c in cols if c not in ("id", "protection_mode")]
            keep_cols_str = ", ".join(keep_cols)
            conn.execute(
                f"INSERT INTO my_profile ({keep_cols_str}) SELECT {keep_cols_str} FROM my_profile_old"
            )
            # 老主号 account_pool_id 兜底为第一条 operation
            op_row = conn.execute(
                "SELECT id FROM account_pool WHERE role='operation' ORDER BY id LIMIT 1"
            ).fetchone()
            if op_row:
                conn.execute(
                    "UPDATE my_profile SET account_pool_id=? WHERE account_pool_id IS NULL",
                    (op_row["id"],),
                )
            conn.execute("DROP TABLE my_profile_old")
            conn.commit()
            print("[db] my_profile 已升级为多行模式")
        finally:
            conn.execute("PRAGMA foreign_keys=ON")

    # 4. backfill notes/items.account_pool_id
    _backfill_account_pool_id(conn)


def _backfill_account_pool_id(conn: sqlite3.Connection) -> None:
    """把现有 notes / items 中 account_pool_id 为空的行，关联到第一个 operation 账号。
    幂等：已有值的不动。"""
    op = conn.execute(
        "SELECT id FROM account_pool WHERE role='operation' ORDER BY id LIMIT 1"
    ).fetchone()
    if not op:
        return
    op_id = op["id"]
    # 只 backfill 有这一列的表
    for tbl in ("notes", "items"):
        cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({tbl})").fetchall()]
        if "account_pool_id" not in cols:
            continue
        n = conn.execute(
            f"UPDATE {tbl} SET account_pool_id=? WHERE account_pool_id IS NULL",
            (op_id,),
        ).rowcount
        if n > 0:
            print(f"[db] backfill {tbl}.account_pool_id={op_id}（{n} 行）")
    conn.commit()
