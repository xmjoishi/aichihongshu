import { access, readFile } from "node:fs/promises";
import process from "node:process";

async function main() {
  const logPath = process.env.AICHIHONGSHU_PYTHON_DENY_LOG;
  if (!logPath) throw new Error("AICHIHONGSHU_PYTHON_DENY_LOG is not set");

  try {
    await access(logPath);
  } catch {
    process.stdout.write("No Python command attempts were recorded.\n");
    return;
  }

  const attempts = (await readFile(logPath, "utf8")).trim();
  if (!attempts) {
    process.stdout.write("No Python command attempts were recorded.\n");
    return;
  }

  process.stderr.write(`Python command attempts were blocked:\n${attempts}\n`);
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
