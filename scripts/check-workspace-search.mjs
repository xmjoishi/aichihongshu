import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const required = [
  ["client/src/lib/workspaceSearch.ts", ["searchWorkspace", "WorkspaceSearchResult", "inspiration"]],
  ["client/src/pages/WorkspaceSearch.tsx", ["当前账号", "local-search", "sessionStorage", "searchWorkspace", "readLocalInspirations", "saveLocalInspiration"]],
  ["client/src/App.tsx", ["WorkspaceSearch", 'path="/search"']],
  ["client/src/components/Sidebar.tsx", ["label: \"搜索\"", 'to: "/search"']],
  ["client/src/pages/Library.tsx", ["library-view.v1", "searchParams.get(\"item\")"]],
  ["client/src/pages/Notes.tsx", ["notes-view.v1", "notesScrollRef"]],
];

const failures = [];
for (const [relative, markers] of required) {
  const filename = path.join(root, relative);
  const source = fs.readFileSync(filename, "utf8");
  for (const marker of markers) {
    if (!source.includes(marker)) failures.push(`${relative}: missing ${marker}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(2);
}

console.log(JSON.stringify({ ok: true, scope: "workspace-search-and-view-preferences", files: required.length }));
