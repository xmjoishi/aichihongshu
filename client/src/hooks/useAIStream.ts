import { useState, useCallback, useRef } from "react";
import { api } from "../lib/api";

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

interface UseAIStreamOptions {
  noteId?: number;
  itemId?: number;
  systemExtra?: string;
}

/**
 * SSE 流式 AI 对话 Hook
 * 返回消息列表、流式输出中的 pending 文本、发送函数、加载状态和清空函数
 */
export function useAIStream(opts: UseAIStreamOptions = {}) {
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const send = useCallback(
    (userText: string) => {
      if (!userText.trim() || loading) return;
      setError(null);

      const userMsg: AIMessage = { role: "user", content: userText };
      const newMessages = [...messages, userMsg];
      setMessages(newMessages);
      setStreaming("");
      setLoading(true);

      let buffer = "";

      ctrlRef.current = api.stream(
        "/api/ai/chat",
        {
          messages: newMessages,
          note_id: opts.noteId ?? null,
          item_id: opts.itemId ?? null,
          system_extra: opts.systemExtra ?? null,
        },
        (chunk) => {
          if (chunk.text) {
            buffer += chunk.text as string;
            setStreaming(buffer);
          }
        },
        () => {
          // done
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: buffer },
          ]);
          setStreaming("");
          setLoading(false);
        },
        (err) => {
          setError(err.message);
          setLoading(false);
        },
      );
    },
    [messages, loading, opts.noteId, opts.itemId, opts.systemExtra],
  );

  const clear = useCallback(() => {
    ctrlRef.current?.abort();
    setMessages([]);
    setStreaming("");
    setLoading(false);
    setError(null);
  }, []);

  const abort = useCallback(() => {
    ctrlRef.current?.abort();
    setLoading(false);
  }, []);

  return { messages, streaming, loading, error, send, clear, abort };
}
