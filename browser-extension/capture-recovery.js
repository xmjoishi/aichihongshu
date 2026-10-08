// Pure capture outcome helpers, also exercised without a browser in fixtures.
(() => {
  function requestedOutcomes(message) {
    const modules = message?.modules || {};
    return {
      collectRequested: Object.values(modules.collect || {}).some(Boolean),
      detailsRequested: Boolean(modules.collect?.images || modules.collect?.comments),
      imageBytesRequested: Boolean(message?.imageTransferProtocol && Array.isArray(message?.images) && message.images.length),
      snapshotRequested: Boolean(modules.data?.metrics || modules.data?.publishedAt),
      profileNotesRequested: message?.profileNotesRequested === true,
    };
  }

  function missingOutcomes(message, status = {}) {
    const requested = requestedOutcomes(message);
    const missing = [];
    if (requested.collectRequested && status.collectionSaved !== true) missing.push("素材收藏");
    if (requested.detailsRequested && status.captureDetailsSaved !== true) missing.push("图片/评论摘录");
    if (requested.imageBytesRequested) {
      const total = Number(status.imagesTotal);
      const ready = Number(status.imagesReady);
      const expected = message.images.length;
      if (total !== expected || ready !== expected) {
        missing.push(`原图本地落地（${Number.isFinite(ready) ? ready : 0}/${expected}）`);
      }
    }
    if (requested.snapshotRequested && status.snapshotSaved !== true) missing.push("数据快照");
    if (requested.profileNotesRequested && status.profileNotesSaved !== true) missing.push("主页笔记同步");
    return missing;
  }

  function buildLookupRequest(message, protocolVersion, extensionVersion) {
    if (!message || typeof message.requestId !== "string" || !message.requestId.trim()
      || message.requestId.trim() !== message.requestId || message.requestId.length > 128
      || !Number.isSafeInteger(message.targetAccountId) || message.targetAccountId <= 0) {
      return null;
    }
    return {
      action: "lookup_capture_request",
      protocolVersion,
      requestId: message.requestId,
      targetAccountId: message.targetAccountId,
      extensionVersion: extensionVersion || "",
    };
  }

  function matchesIdentity(response, expectedChannel, expectedWorkspaceId = "") {
    if (!response || response.channel !== expectedChannel
      || typeof response.workspaceId !== "string" || !response.workspaceId) return false;
    return !expectedWorkspaceId || response.workspaceId === expectedWorkspaceId;
  }

  function matchesRequest(status, message) {
    return Boolean(status && message
      && status.requestId === message.requestId
      && status.targetAccountId === message.targetAccountId);
  }

  function classifySaveResponse(message, result, identityMatches) {
    const response = result?.response;
    if (response && !identityMatches) return "identity_mismatch";
    if (result?.timedOut || result?.runtimeError || !response
      || /无法连接桌面应用|结束消息发送失败|发送到桌面应用失败|读取桌面应用回执失败|没有返回回执|回执超过 (?:64|160)KB|回执不是有效 JSON|回执格式无效/.test(response.error || "")) {
      return "lookup";
    }
    if (response.ok !== true) return "rejected";
    return missingOutcomes(message, response.outcomes || response).length ? "lookup" : "complete";
  }

  globalThis.AichiCaptureRecovery = {
    requestedOutcomes,
    missingOutcomes,
    buildLookupRequest,
    matchesIdentity,
    matchesRequest,
    classifySaveResponse,
  };
})();
