// Safe, structured Native Messaging diagnostics. Never include account or page data.
(() => {
  const ACTIONS = {
    HOST_MISSING: { label: "浏览器宿主未安装", action: "在桌面端设置 → 浏览器插件中安装/修复当前浏览器的 Native Host，然后重载插件。" },
    HOST_REGISTRATION_OLD: { label: "浏览器宿主注册过旧", action: "在桌面端设置中重新安装/修复当前通道，确认清单指向最新无界面启动器，再重载插件。" },
    HOST_START_FAILED: { label: "浏览器宿主启动失败", action: "在桌面端设置中检查并修复当前浏览器的宿主注册；若路径已失效，从对应桌面实例重新安装。" },
    INSTANCE_OFFLINE: { label: "桌面实例未运行", action: "点击“启动桌面端”启动已绑定实例，或显式选择另一个实例。" },
    INSTANCE_SELECTION_REQUIRED: { label: "需要选择桌面实例", action: "从实例列表中明确选择目标工作区后连接。" },
    INSTANCE_NOT_REGISTERED: { label: "目标实例注册不可用", action: "在目标工作区桌面端设置中重新安装/修复当前通道，然后重载插件。" },
    INSTANCE_START_FAILED: { label: "桌面实例启动失败", action: "从桌面端设置重新注册该实例；检查应用是否仍位于原安装位置。" },
    INSTANCE_MISMATCH: { label: "桌面实例身份不匹配", action: "关闭插件弹窗并重新打开，或从实例选择器明确选择目标工作区。" },
    CHANNEL_MISMATCH: { label: "桌面通道不匹配", action: "安装与插件通道相同的正式版或 DEV 宿主，不会自动切换通道。" },
    PROTOCOL_INCOMPATIBLE: { label: "插件与桌面协议不兼容", action: "更新同一通道的桌面端和插件，然后在浏览器扩展页重载插件。" },
    ACCOUNT_READ_FAILED: { label: "本地账号读取失败", action: "确认所选桌面实例已就绪，再点击“重试读取账号”；页面预览仍保留。" },
    UNKNOWN_TIMEOUT: { label: "连接检测超时", action: "检查桌面端是否响应，再手动重试；未确认写入结果前不要重复提交。" },
    UNKNOWN_ERROR: { label: "连接检测失败", action: "复制脱敏诊断并检查当前浏览器、通道和桌面版本。" },
  };

  function classify({ step = "desktop_instance", response = null, runtimeError = "", timedOut = false, action = "" } = {}) {
    const code = response?.errorCode;
    if (typeof code === "string" && ACTIONS[code]) return { code, ...ACTIONS[code] };
    const raw = String(runtimeError || response?.error || "");
    if (timedOut || /timed?\s*out|超时/i.test(raw)) return { code: "UNKNOWN_TIMEOUT", ...ACTIONS.UNKNOWN_TIMEOUT };
    if (/specified native messaging host.*not found|native messaging host.*not found|host.*not installed/i.test(raw)) {
      return { code: "HOST_MISSING", ...ACTIONS.HOST_MISSING };
    }
    if (/native messaging host.*(forbidden|blocked)|access to .*host.*forbidden/i.test(raw)) {
      return { code: "HOST_REGISTRATION_OLD", ...ACTIONS.HOST_REGISTRATION_OLD };
    }
    if (/native host.*(exit|start|launch)|failed to start native host|无法启动.*host/i.test(raw)) {
      return { code: "HOST_START_FAILED", ...ACTIONS.HOST_START_FAILED };
    }
    if (action === "list_capture_instances" && response && response.ok !== true
      && (!code || code === "REQUEST_REJECTED")) {
      return { code: "HOST_REGISTRATION_OLD", ...ACTIONS.HOST_REGISTRATION_OLD };
    }
    if (step === "account_read") return { code: "ACCOUNT_READ_FAILED", ...ACTIONS.ACCOUNT_READ_FAILED };
    return { code: "UNKNOWN_ERROR", ...ACTIONS.UNKNOWN_ERROR };
  }

  function redactedRecord({ extensionVersion = "", appVersion = "", channel = "prod", step = "", errorCode = "", durationMs = null } = {}) {
    return {
      extensionVersion: String(extensionVersion).slice(0, 32),
      appVersion: String(appVersion).slice(0, 32),
      channel: channel === "dev" ? "dev" : "prod",
      step: String(step).slice(0, 32),
      errorCode: String(errorCode).slice(0, 48),
      durationMs: Number.isFinite(Number(durationMs)) ? Math.max(0, Math.min(120_000, Math.round(Number(durationMs)))) : null,
    };
  }

  globalThis.AichiConnectionDiagnostics = { classify, redactedRecord, knownCodes: Object.keys(ACTIONS) };
})();
