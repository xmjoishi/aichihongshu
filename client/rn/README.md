# Rust `rn` CLI / MCP

`rn` is a standalone Rust executable. It shares the app's SQLite and image-analysis services and does not start Tauri or Python.

From this directory's parent (`client/`), run it during development:

```sh
pnpm rn -- --help
pnpm rn -- --db /absolute/path/to/app.db db init
```

Initializing a missing database prints its full path and asks for confirmation. For automation, pass `--yes` after `db init`; this acknowledges creation of a new database at the displayed path.

Install the executable from a repository checkout with Cargo:

```sh
cargo install --path client/rn --locked
rn --help
```

Set `AICHIHONGSHU_DB_PATH` to select a database. For compatibility, `DB_PATH`, the project's `.env`, and `data/app.db` remain the fallback order. `rn mcp` starts an MCP stdio server with 22 tools: the original 14 schemas stay unchanged, with note search and PC-only memory/experience management added. Mobile memory and experience caches are not writable through MCP. Set `AICHIHONGSHU_MCP_ALLOWED_IMPORT_DIR` in its process environment before allowing it to import local files. The variable must point to an existing directory; resolved files outside it, including symlinks that leave the directory, are rejected. `rn mcp config` intentionally leaves this optional permission unset. `publish_note` records a local status and link only; it does not publish to the platform.

`rn search --keywords "家居,软装" --count 20` performs a bounded search in the visible, account-isolated Playwright session and writes JSON under `data/crawl/`. It supports up to five keywords and 50 notes per keyword. Log in through the account-pool browser first; the command stops on login or verification and never automates those steps. Set `AICHIHONGSHU_BROWSER_WORKER_DIR` when the worker is not beside the executable or in the development checkout. `--save-db` records the result count and output path in the active account's crawl history. Read recent scoped records with `rn crawl history [--limit 20]`.

`rn profile init --url "https://www.xiaohongshu.com/user/profile/ACCOUNT_ID"` reads the active account's own visible profile and up to 30 rendered notes in its isolated browser session, then attempts to infer profile fields with the configured Model API Provider. Log in or complete any verification manually in the visible browser. `--niche`, `--audience`, `--pillars`, `--persona-tone`, `--rhythm`, `--taboos`, `--styles`, `--scenes`, and `--hashtags` override inferred values; nonzero manual statistics override captured values. AI inference failure keeps existing profile fields and still saves the captured profile. The URL must match an existing account binding when one is set.

For manual initialization, pass both `--name` and `--niche`; `rn profile edit` updates selected fields without replacing the others.

Image analysis uses the MiniMax Token Plan VLM service. It reads the MiniMax API key from desktop Model API settings first, then `MINIMAX_API_KEY` / `AICHIHONGSHU_MINIMAX_API_KEY` for development compatibility.
