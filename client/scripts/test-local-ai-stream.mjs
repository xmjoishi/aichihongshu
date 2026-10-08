import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourcePath = new URL("../src/lib/localAiStream.ts", import.meta.url);
const source = await readFile(sourcePath, "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const helperUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const { startLocalAIStream } = await import(helperUrl);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const eventNames = ["local-ai://chunk", "local-ai://done", "local-ai://error"];

function callbacks() {
  const handlers = new Map();
  const unlisteners = [];
  return {
    handlers,
    unlisteners,
    listen: (name, callback) => {
      handlers.set(name, callback);
      return Promise.resolve(() => unlisteners.push(name));
    },
  };
}

function options(overrides = {}) {
  return {
    runId: "run-1",
    startRun: async () => {},
    cancelCommand: "cancel-run",
    listen: async () => () => {},
    invoke: async () => {},
    onChunk: () => {},
    onDone: () => {},
    onError: () => {},
    fallbackError: "stream failed",
    ...overrides,
  };
}

async function cancellationBeforeListenerRegistrationFinishes() {
  const registrations = eventNames.map(() => deferred());
  const cancelled = [];
  const released = [];
  let starts = 0;
  let index = 0;
  const controller = startLocalAIStream(options({
    listen: () => registrations[index++].promise,
    invoke: async (command) => cancelled.push(command),
    startRun: async () => { starts += 1; },
  }));

  controller.abort();
  registrations.forEach((registration, i) => registration.resolve(() => released.push(eventNames[i])));
  await flush();

  assert.equal(starts, 0, "a cancelled stream must not start after listeners resolve");
  assert.deepEqual(cancelled, ["cancel-run"]);
  assert.deepEqual(released.sort(), [...eventNames].sort(), "late listeners must all be released");
}

async function partialRegistrationFailureReleasesLateListeners() {
  const late = deferred();
  const released = [];
  const errors = [];
  let starts = 0;
  let index = 0;
  const registrations = [
    Promise.resolve(() => released.push("first")),
    Promise.reject(new Error("listen failed")),
    late.promise,
  ];
  const controller = startLocalAIStream(options({
    listen: () => registrations[index++],
    startRun: async () => { starts += 1; },
    onError: (error) => errors.push(error.message),
  }));

  await flush();
  late.resolve(() => released.push("late"));
  await flush();

  assert.equal(starts, 0);
  assert.deepEqual(errors, ["listen failed"]);
  assert.deepEqual(released.sort(), ["first", "late"]);
  controller.abort();
}

async function cancellationDuringStartIsCompensated() {
  const registry = callbacks();
  const starting = deferred();
  const cancelled = [];
  let starts = 0;
  const controller = startLocalAIStream(options({
    listen: registry.listen,
    startRun: () => { starts += 1; return starting.promise; },
    invoke: async (command) => cancelled.push(command),
  }));

  await flush();
  assert.equal(starts, 1, "start begins only after all listeners register");
  controller.abort();
  await flush();
  starting.resolve();
  await flush();

  assert.deepEqual(cancelled, ["cancel-run", "cancel-run"], "start/cancel race gets an idempotent second cancel");
  assert.equal(registry.unlisteners.length, 3);
}

async function completionIsSingleAndIgnoresLaterEventsAndAbort() {
  const registry = callbacks();
  const chunks = [];
  let done = 0;
  let errors = 0;
  let cancels = 0;
  const controller = startLocalAIStream(options({
    listen: registry.listen,
    onChunk: (text) => chunks.push(text),
    onDone: () => { done += 1; },
    onError: () => { errors += 1; },
    invoke: async () => { cancels += 1; },
  }));

  await flush();
  registry.handlers.get("local-ai://chunk")({ payload: { runId: "other-run", text: "ignored" } });
  registry.handlers.get("local-ai://chunk")({ payload: { runId: "run-1", text: "kept" } });
  registry.handlers.get("local-ai://done")({ payload: { runId: "run-1" } });
  registry.handlers.get("local-ai://done")({ payload: { runId: "run-1" } });
  registry.handlers.get("local-ai://error")({ payload: { runId: "run-1", error: "late error" } });
  controller.abort();
  await flush();

  assert.deepEqual(chunks, ["kept"]);
  assert.equal(done, 1);
  assert.equal(errors, 0);
  assert.equal(cancels, 0, "abort after completion must not send a cancellation");
  assert.equal(registry.unlisteners.length, 3);
}

for (const [name, test] of [
  ["cancel before listeners resolve", cancellationBeforeListenerRegistrationFinishes],
  ["partial listener registration failure", partialRegistrationFailureReleasesLateListeners],
  ["cancel during start", cancellationDuringStartIsCompensated],
  ["single terminal state and run filtering", completionIsSingleAndIgnoresLaterEventsAndAbort],
]) {
  await test();
  console.log(`✓ ${name}`);
}
