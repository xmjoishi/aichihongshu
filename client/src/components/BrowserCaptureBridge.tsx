import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useToast } from "./Toast";
import { useAccountContext } from "../lib/accountContext";
import { validateBrowserCapture } from "../lib/browserCapture";
import { IS_TAURI_RUNTIME, LOCAL_INSPIRATIONS_UPDATED_EVENT, saveLocalInspiration, savePageSnapshot } from "../lib/local";

/**
 * Keep the extension transport alive across route changes. Browser collection
 * is persisted by the Rust host before it acknowledges Native Messaging. This
 * bridge reports the result and refreshes the list; snapshots save after update.
 */
export default function BrowserCaptureBridge() {
  const { toast } = useToast();
  const { accountId } = useAccountContext();

  useEffect(() => {
    if (!IS_TAURI_RUNTIME || accountId === null) return;

    const acceptCapture = async (raw: unknown, collectionAlreadySaved = false) => {
      const validated = validateBrowserCapture(raw, accountId);
      if (!validated.ok) {
        toast(validated.message, "error");
        return;
      }

      const capture = validated.value;
      const wantsCollect = capture.modules.collect.titleBody || capture.modules.collect.authorSource;
      const wantsData = capture.modules.data.metrics;
      let collectionSaved = false;
      let collectionError = "";
      let dataSaved = false;
      let dataError = "";

      if (wantsCollect) {
        if (collectionAlreadySaved) {
          collectionSaved = true;
        } else {
          try {
            const requestSuffix = (capture.requestId || crypto.randomUUID()).slice(0, 96);
            await saveLocalInspiration({
              id: `bc:${capture.targetAccountId}:${requestSuffix}`,
              accountPoolId: capture.targetAccountId,
              title: capture.title,
              sourceUrl: capture.sourceUrl,
              body: capture.modules.collect.titleBody ? capture.body : "",
              observedAt: capture.observedAt,
              reason: capture.reason,
              dedupeKey: capture.dedupeKey,
              materialType: capture.materialType,
              author: capture.modules.collect.authorSource ? capture.author : "",
              captureModules: [
                ...(capture.modules.collect.titleBody ? ["titleBody"] : []),
                ...(capture.modules.collect.authorSource ? ["authorSource"] : []),
                ...(capture.modules.data.metrics ? ["metrics"] : []),
              ],
            });
            collectionSaved = true;
          } catch (error) {
            collectionError = error instanceof Error ? error.message : String(error);
          }
        }
      }

      if (wantsData && capture.kind !== "clip") {
        try {
          await savePageSnapshot({
            accountPoolId: capture.targetAccountId,
            kind: capture.kind,
            sourceUrl: capture.sourceUrl,
            title: capture.title,
            author: capture.author,
            bodyExcerpt: capture.body.slice(0, 4000),
            metrics: {
              like: capture.metrics.like ?? null,
              collect: capture.metrics.collect ?? null,
              comment: capture.metrics.comment ?? null,
              followers: capture.metrics.followers ?? null,
              noteCount: capture.metrics.noteCount ?? null,
            },
            referenceAccountId: capture.referenceAccountId,
            ...(capture.requestId ? { requestId: capture.requestId } : {}),
            observedAt: capture.observedAt,
          });
          dataSaved = true;
        } catch (error) {
          dataError = error instanceof Error ? error.message : String(error);
        }
      }

      if (collectionSaved) {
        window.dispatchEvent(new CustomEvent(LOCAL_INSPIRATIONS_UPDATED_EVENT, {
          detail: { accountPoolId: capture.targetAccountId },
        }));
      }

      const messages: string[] = [];
      if (collectionSaved) messages.push("浏览器收藏已保存到网页收藏");
      if (collectionError) messages.push(`网页收藏保存失败：${collectionError}`);
      if (dataSaved) messages.push("数据快照已更新");
      if (dataError) messages.push(`数据快照失败：${dataError}`);
      if (!wantsCollect && !wantsData) messages.push("未勾选任何模块，未入库");
      if (wantsData && capture.kind === "clip") messages.push("当前页面类型不支持更新数据");
      if (messages.length > 0) {
        const failed = Boolean(dataError || collectionError);
        toast(messages.join("；"), failed ? "error" : "success");
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== "AICHIHONGSHU_BROWSER_CAPTURE") return;
      void acceptCapture(data.message ?? data.payload ?? data, false);
    };
    const onCaptureEvent = (event: Event) => {
      void acceptCapture((event as CustomEvent).detail, false);
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("aichihongshu-browser-capture", onCaptureEvent);
    let unlistenTauri: (() => void) | undefined;
    let disposed = false;
    void listen("browser-capture://message", (event) => {
      void acceptCapture(event.payload, true);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenTauri = unlisten;
      })
      .catch(() => {
        // Keep the window message channels available when the Tauri bridge is absent.
      });

    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
      window.removeEventListener("aichihongshu-browser-capture", onCaptureEvent);
      unlistenTauri?.();
    };
  }, [accountId, toast]);

  return null;
}
