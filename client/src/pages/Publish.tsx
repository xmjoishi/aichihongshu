import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Note } from "../lib/types";
import { Spinner, StatusBadge } from "../components/ui";
import { useToast } from "../components/Toast";

export default function Publish() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: notes = [], isLoading } = useQuery<Note[]>({
    queryKey: ["notes-all"],
    queryFn: () => api.get("/api/content/"),
  });

  const columns: { status: "draft" | "ready" | "published"; label: string; color: string }[] = [
    { status: "draft", label: "草稿", color: "border-zinc-200" },
    { status: "ready", label: "待发布", color: "border-amber-300" },
    { status: "published", label: "已发布", color: "border-green-300" },
  ];

  async function moveTo(noteId: number, newStatus: "draft" | "ready" | "published") {
    // 乐观更新：立即更新本地缓存
    qc.setQueryData<Note[]>(["notes-all"], (old = []) =>
      old.map((n) => (n.id === noteId ? { ...n, status: newStatus } : n))
    );
    qc.setQueryData<Note[]>(["notes"], (old = []) =>
      old.map((n) => (n.id === noteId ? { ...n, status: newStatus } : n))
    );

    try {
      await api.patch(`/api/content/${noteId}/status`, { status: newStatus });
      // 成功后同步服务端数据
      qc.invalidateQueries({ queryKey: ["notes-all"] });
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
    } catch (e: unknown) {
      // 回滚：重新拉取
      qc.invalidateQueries({ queryKey: ["notes-all"] });
      toast((e as Error).message, "error");
    }
  }

  if (isLoading) return <Spinner />;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-6 py-4 border-b border-zinc-100 bg-white">
        <h1 className="text-lg font-semibold text-zinc-900">发布工作流</h1>
        <span className="ml-3 text-xs text-zinc-400">点击按钮移动笔记状态</span>
      </div>

      <div className="flex-1 overflow-x-auto p-6">
        <div className="flex gap-4 h-full min-h-0" style={{ minWidth: "700px" }}>
          {columns.map((col) => {
            const colNotes = notes.filter((n) => n.status === col.status);
            return (
              <div key={col.status} className="flex-1 flex flex-col min-w-52">
                <div className={`flex items-center gap-2 mb-3 pb-2 border-b-2 ${col.color}`}>
                  <StatusBadge status={col.status} />
                  <span className="text-xs text-zinc-400">({colNotes.length})</span>
                </div>
                <div className="flex-1 overflow-y-auto space-y-2">
                  {colNotes.length === 0 ? (
                    <p className="text-xs text-zinc-300 text-center py-8">暂无</p>
                  ) : (
                    colNotes.map((note) => (
                      <div key={note.id}
                        className="bg-white rounded-xl p-3 border border-zinc-100 shadow-sm
                                   transition-all hover:shadow-md hover:-translate-y-0.5">
                        <p className="text-xs font-medium text-zinc-800 line-clamp-2 mb-2">
                          {note.title || "（未填写标题）"}
                        </p>
                        {note.tags.length > 0 && (
                          <p className="text-xs text-[#ff2442] mb-2 truncate">
                            {note.tags.slice(0, 3).map((t) => `#${t}`).join(" ")}
                          </p>
                        )}
                        {note.status === "published" && (
                          <div className="flex gap-3 text-xs text-zinc-400 mb-2">
                            <span>❤ {note.likes}</span>
                            <span>💬 {note.comments}</span>
                            <span>⭐ {note.collects}</span>
                          </div>
                        )}
                        <div className="flex gap-1 flex-wrap">
                          {col.status !== "draft" && (
                            <button onClick={() => moveTo(note.id, "draft")}
                              className="text-xs text-zinc-400 hover:text-zinc-600 border border-zinc-100 px-2 py-0.5 rounded transition-colors">
                              退回草稿
                            </button>
                          )}
                          {col.status === "draft" && (
                            <button onClick={() => moveTo(note.id, "ready")}
                              className="text-xs text-amber-600 border border-amber-200 bg-amber-50 px-2 py-0.5 rounded hover:bg-amber-100 transition-colors">
                              → 待发
                            </button>
                          )}
                          {col.status === "ready" && (
                            <button onClick={() => moveTo(note.id, "published")}
                              className="text-xs text-green-600 border border-green-200 bg-green-50 px-2 py-0.5 rounded hover:bg-green-100 transition-colors">
                              ✓ 已发布
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
