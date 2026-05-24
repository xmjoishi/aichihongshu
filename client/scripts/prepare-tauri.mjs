import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd(), "..");

async function ensure(rel) {
  const target = path.join(root, rel);
  try {
    await access(target);
  } catch {
    throw new Error(`缺少打包资源: ${rel}`);
  }
}

async function main() {
  await Promise.all([
    ensure("app"),
    ensure("crawler"),
    ensure("tools/MediaCrawler"),
    ensure("pyproject.toml"),
    ensure("uv.lock"),
  ]);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
