# Browser worker

This is the versioned JSON-lines sidecar used by PY04. It owns only app-managed `account-<id>` browser profiles. It never accepts a user-data path, imports an old MediaCrawler profile, or opens the regular Chrome profile. Login is visible; each account gets a separate persistent Playwright context and lock.

Protocol v1 emits a `ready` handshake, then accepts one JSON request per line and writes one bounded JSON response per request. Supported actions are `status`, `open-session`, `open-url`, `collect-profile`, `search-notes`, `close-session`, `clear-session`, `cancel`, and `shutdown`. `collect-profile` reads at most 30 rendered note cards; `search-notes` reads at most 50 rendered results per keyword and performs at most four scrolls. Both strip tracking parameters and stop on login or verification gates. They never click through those gates or call private APIs. URLs are limited to Xiaohongshu hosts plus loopback-only HTTP fixtures for QA. Errors have stable codes (`RUNTIME_MISSING`, `BROWSER_MISSING`, `SESSION_LOCKED`, and related request/launch errors). EOF and SIGTERM close all contexts and release their locks.

The Node service and fake-browser contract tests run without Python, network access, or a graphical browser:

Desktop Profile refresh, Accounts reference import, Web `/api/profile/refresh`, Web `/api/profile/refresh-status`, and the legacy Web `/api/crawler/creator` SSE route use this worker to collect a matching profile and up to 30 rendered recent notes. Rust `rn search` uses `search-notes` for bounded keyword searches; results are written to a JSON file, with optional account-scoped history. The creator SSE route keeps the legacy operation-account risk confirmation. Note-detail/comment parity and searchable history are outside the current supported worker scope; real XHS DOM behavior still needs product acceptance.

```sh
node --test client/browser-worker/test/*.test.mjs
```

Release packaging runs `npm ci`, installs the Chromium revision pinned by Playwright, and stages a runner-native Node executable, the worker, Playwright, and the visible Chromium browser under the app resources directory. The staging script checks the target triple and starts the bundled browser against a local in-memory QA page. Rust supervises the worker and uses app-owned per-account sessions. A native ARM64 macOS resource build and Tauri `.app` bundle passed locally (about 521 MiB of worker resources); the Windows, Linux, and Intel macOS release jobs still need to run before cross-platform distribution is verified. The desktop Profile refresh now uses the worker to capture the bound operator profile and up to 30 rendered notes, then stores them through Rust account-scoped database methods. Note-detail/comment parity and searchable history are outside the current supported worker scope; real XHS DOM behavior still needs product acceptance.
