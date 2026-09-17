import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const checks = [
  ["client/src-tauri/src/db.rs", ["import_local_image", "repair_local_image", "thumbnail_path", "thumbnail_data_base64", "delete_local_item", "restore_local_item", "purge_local_items", "trash_items", "trash_notes", "missing_image_ids", "image_signature_matches", "Sha256", "staging", "create_local_draft_from_items", "update_local_item_metadata", "metadata_version", "delete_local_note", "restore_local_note"]],
  ["client/src-tauri/src/lib.rs", ["import_local_image", "repair_local_image", "variant", "delete_local_item", "restore_local_item", "purge_local_items", "delete_local_note", "restore_local_note", "create_local_draft_from_items", "update_local_item_metadata"]],
  ["client/src/lib/local.ts", ["importLocalImage", "repairLocalImage", "fileToThumbnailBase64", "deleteLocalItem", "restoreLocalItem", "purgeLocalItems", "deleteLocalNote", "restoreLocalNote", "createLocalDraftFromItems", "updateLocalItemMetadata", "missingImageIds", "thumbnailDataBase64", "fileToBase64", "trashNotes"]],
  ["client/src/pages/Library.tsx", ["IS_TAURI_RUNTIME", "importLocalImage", "repairLocalImage", "fileToThumbnailBase64", "thumbnailDataBase64", "deleteLocalItem", "restoreLocalItem", "purgeLocalItems", "createLocalDraftFromItems", "updateLocalItemMetadata", "missingImageIds", "文件缺失", "修复/替换图片", "批量恢复", "永久清理", "回收站"]],
  ["client/src/pages/Notes.tsx", ["deleteLocalNote", "restoreLocalNote", "trashNotes", "笔记会移入当前账号回收站"]],
];

for (const [file, markers] of checks) {
  const source = readFileSync(resolve(file), "utf8");
  for (const marker of markers) {
    if (!source.includes(marker)) throw new Error(`${file} 缺少本地导入边界: ${marker}`);
  }
}

console.log(`local import: ${checks.length} source boundaries checked`);
