import { lstat, realpath, readdir } from "node:fs/promises";
import path from "node:path";

const PYTHON_RESOURCE_DIRECTORY = /^(?:__pycache__|site-packages|dist-packages|venv|\.venv|virtualenv|python(?:[-_]?\d+(?:\.\d+)*)?|pypy(?:[-_]?\d+(?:\.\d+)*)?|python\.framework)$/i;
const PYTHON_RUNTIME_FILE = /^(?:pythonw?|pypy)(?:[-_]?\d+(?:\.\d+)*)?(?:-config)?(?:\.exe|\.dll|\.so(?:\..*)?|\.dylib|\.zip|\.a|\.lib|\.pyd)?$/i;
const PYTHON_METADATA_FILE = /^(?:pyproject\.toml|uv\.lock|pipfile(?:\.lock)?|poetry\.lock|pyvenv\.cfg|requirements(?:[-_.][^/]*)?\.(?:txt|in))$/i;

function normalizeResourcePath(resourcePath) {
  return String(resourcePath).replaceAll("\\", "/").replace(/^\.\//, "");
}

function isRetiredPythonResourceRoot(resourcePath) {
  return normalizeResourcePath(resourcePath)
    .split("/")
    .filter(Boolean)
    .some((segment) => /^(?:app|crawler|mediacrawler)$/i.test(segment));
}

export function pythonResourceViolation(resourcePath) {
  const normalized = normalizeResourcePath(resourcePath);
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";

  if (isRetiredPythonResourceRoot(normalized)) {
    return "retired app/crawler resource root";
  }
  if (segments.some((segment) => PYTHON_RESOURCE_DIRECTORY.test(segment))) {
    return "Python runtime or environment directory";
  }
  if (/\.(?:py|pyc|pyo|pyw|whl|egg|pth)$/i.test(basename)) {
    return "Python source, bytecode, or package file";
  }
  if (PYTHON_METADATA_FILE.test(basename)) {
    return "Python dependency or environment metadata";
  }
  if (PYTHON_RUNTIME_FILE.test(basename) || /^libpython\d*(?:\.\d+)*\.(?:dylib|so(?:\..*)?)$/i.test(basename)) {
    return "Python interpreter or runtime library";
  }
  return null;
}

function resourceSources(configuredResources) {
  if (Array.isArray(configuredResources)) return configuredResources;
  if (configuredResources && typeof configuredResources === "object") {
    return Object.keys(configuredResources);
  }
  return [];
}

export async function findForbiddenPythonResources(configuredResources, tauriRoot) {
  const violations = [];
  const root = path.resolve(tauriRoot);

  async function scan(absolutePath, displayPath, allowedRoot, visitedDirectories) {
    const reason = pythonResourceViolation(displayPath);
    if (reason) {
      violations.push(`${displayPath} (${reason})`);
      return;
    }

    let details;
    try {
      details = await lstat(absolutePath);
    } catch {
      violations.push(`${displayPath} (resource cannot be audited: missing)`);
      return;
    }
    if (details.isSymbolicLink()) {
      let resolvedTarget;
      try {
        resolvedTarget = await realpath(absolutePath);
      } catch {
        violations.push(`${displayPath} (resource symlink target cannot be resolved)`);
        return;
      }
      const relativeTarget = path.relative(allowedRoot, resolvedTarget);
      if (
        relativeTarget === ".." ||
        relativeTarget.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeTarget)
      ) {
        violations.push(`${displayPath} (resource symlink escapes its packaged resource tree)`);
        return;
      }
      const targetDisplayPath = `${displayPath} -> ${normalizeResourcePath(relativeTarget)}`;
      await scan(resolvedTarget, targetDisplayPath, allowedRoot, visitedDirectories);
      return;
    }
    if (!details.isDirectory()) return;

    if (visitedDirectories.has(absolutePath)) return;
    visitedDirectories.add(absolutePath);
    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      await scan(
        path.join(absolutePath, child.name),
        `${normalizeResourcePath(displayPath).replace(/\/$/, "")}/${child.name}`,
        allowedRoot,
        visitedDirectories,
      );
    }
  }

  for (const source of resourceSources(configuredResources)) {
    if (typeof source !== "string" || !source.trim()) {
      violations.push(`${String(source)} (invalid bundle resource source)`);
      continue;
    }
    if (/[?*{}\[\]]/.test(source)) {
      violations.push(`${source} (wildcard bundle resource cannot be audited safely)`);
      continue;
    }
    const normalized = normalizeResourcePath(source);
    const absolutePath = path.resolve(root, source);
    let allowedRoot;
    try {
      allowedRoot = await realpath(absolutePath);
    } catch {
      violations.push(`${normalized} (resource cannot be audited: missing)`);
      continue;
    }
    await scan(absolutePath, normalized, allowedRoot, new Set());
  }

  return violations;
}
