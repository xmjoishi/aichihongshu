import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { CheckCircle, XCircle, AlertTriangle, X } from "lucide-react";

type ToastType = "success" | "error" | "warning" | "info";
interface Toast { id: number; type: ToastType; message: string }
interface ToastCtx { toast: (msg: string, type?: ToastType) => void }

const Ctx = createContext<ToastCtx>({ toast: () => {} });
let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  const remove = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const icons = {
    success: <CheckCircle size={15} className="text-green-500 shrink-0" />,
    error: <XCircle size={15} className="text-red-500 shrink-0" />,
    warning: <AlertTriangle size={15} className="text-amber-500 shrink-0" />,
    info: <CheckCircle size={15} className="text-blue-500 shrink-0" />,
  };

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      {/* Toast 容器 */}
      <div className="fixed bottom-5 left-5 right-5 z-50 flex max-h-[calc(100vh-2.5rem)] flex-col items-end gap-2 overflow-y-auto pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex w-full min-w-0 max-w-xs items-start gap-2.5 bg-white border border-zinc-200
                       shadow-lg rounded-xl px-4 py-3 animate-in slide-in-from-right-4
                       text-sm text-zinc-700"
          >
            <span className="mt-0.5">{icons[t.type]}</span>
            <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{t.message}</span>
            <button onClick={() => remove(t.id)} className="mt-0.5 shrink-0 text-zinc-300 hover:text-zinc-500">
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}
