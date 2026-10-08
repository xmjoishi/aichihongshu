export interface LocalAIStreamEvent {
  runId: string;
  text?: string;
  error?: string;
}

type Unlisten = () => void;
type Listen = (
  eventName: string,
  callback: (event: { payload: LocalAIStreamEvent }) => void,
) => Promise<Unlisten>;
type Invoke = (command: string, args: { runId: string }) => Promise<unknown>;

export interface StartLocalAIStreamOptions {
  runId: string;
  startRun: () => Promise<unknown>;
  cancelCommand: string;
  listen: Listen;
  invoke: Invoke;
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  fallbackError: string;
}

/** Shared listener/start/cancel lifecycle for CLI and Model API event streams. */
export function startLocalAIStream(options: StartLocalAIStreamOptions): AbortController {
  const {
    runId,
    startRun,
    cancelCommand,
    listen,
    invoke,
    onChunk,
    onDone,
    onError,
    fallbackError,
  } = options;
  const controller = new AbortController();
  const listeners: Unlisten[] = [];
  let settled = false;

  const cleanup = () => {
    while (listeners.length > 0) {
      try {
        listeners.pop()?.();
      } catch {
        // Release every listener even if one unlisten callback fails.
      }
    }
  };
  const finish = (callback?: () => void) => {
    if (settled) return false;
    settled = true;
    cleanup();
    callback?.();
    return true;
  };

  const register = (eventName: string, callback: (event: { payload: LocalAIStreamEvent }) => void) =>
    listen(eventName, callback).then((unlisten) => {
      // Cancellation or a partial registration failure may win this race.
      if (settled) unlisten();
      else listeners.push(unlisten);
    });

  controller.signal.addEventListener("abort", () => {
    if (!finish()) return;
    void invoke(cancelCommand, { runId }).catch(() => {
      // Cancellation is idempotent; the run may already have ended.
    });
  }, { once: true });

  void (async () => {
    try {
      await Promise.all([
        register("local-ai://chunk", (event) => {
          if (!settled && event.payload.runId === runId && event.payload.text) onChunk(event.payload.text);
        }),
        register("local-ai://done", (event) => {
          if (event.payload.runId === runId) finish(onDone);
        }),
        register("local-ai://error", (event) => {
          if (event.payload.runId === runId) {
            finish(() => onError(new Error(event.payload.error || fallbackError)));
          }
        }),
      ]);
      if (settled) return;
      await startRun();
      // Abort may have raced with the command's registration on the Rust side.
      if (controller.signal.aborted) {
        void invoke(cancelCommand, { runId }).catch(() => {
          // A second idempotent cancel closes the start/cancel race.
        });
      }
    } catch (error) {
      finish(() => {
        if (!controller.signal.aborted) onError(error instanceof Error ? error : new Error(String(error)));
      });
    }
  })();

  return controller;
}
