(() => {
  // ── 顶栏滚动收窄 ──
  const siteHeader = document.querySelector(".site-header");
  const snapMain = document.querySelector(".snap-main");
  if (siteHeader) {
    const onScroll = () => {
      const scrollTop = snapMain ? snapMain.scrollTop : window.scrollY;
      siteHeader.classList.toggle("scrolled", scrollTop > 20);
    };
    if (snapMain) {
      snapMain.addEventListener("scroll", onScroll, { passive: true });
    } else {
      window.addEventListener("scroll", onScroll, { passive: true });
    }
    onScroll();
  }

  // ── 产品展示 iframe 缩放 ──
  const STAGE_WIDTH = 1180;
  const STAGE_HEIGHT = 720;

  function fitStage(stage) {
    const fit = stage.querySelector("[data-preview-fit]");
    if (!fit) return;
    const scale = Math.min(stage.clientWidth / STAGE_WIDTH, stage.clientHeight / STAGE_HEIGHT);
    fit.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }

  function fitAllStages() {
    document.querySelectorAll("[data-preview-stage]").forEach(fitStage);
  }

  window.addEventListener("resize", fitAllStages, { passive: true });
  fitAllStages();

  // ── loading 遮罩 ──
  function showFrameLoading(stage) {
    if (!stage) return;
    let overlay = stage.querySelector(".preview-loading");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "preview-loading";
      overlay.setAttribute("aria-hidden", "true");
      stage.appendChild(overlay);
    }
    overlay.style.display = "flex";
  }

  function hideFrameLoading(stage) {
    if (!stage) return;
    const overlay = stage.querySelector(".preview-loading");
    if (overlay) overlay.style.display = "none";
  }

  // ── showcase：postMessage 驱动切换 ──
  const showcase = document.querySelector("[data-showcase]");
  if (showcase) {
    const frame = showcase.querySelector("[data-preview-frame]");
    const stage = showcase.querySelector("[data-preview-stage]");
    const panels = showcase.querySelectorAll("[data-copy-panel]");

    // iframe 加载完毕隐藏遮罩
    if (frame && stage) {
      frame.addEventListener("load", () => {
        hideFrameLoading(stage);
        fitStage(stage);
      });
    }

    function activateTab(tab, src) {
      // 切换 iframe src
      if (frame && src) {
        if (frame.getAttribute("src") !== src) {
          showFrameLoading(stage);
          frame.setAttribute("src", src);
        }
      }
      // 切换右侧卡片
      panels.forEach((panel) => {
        panel.classList.toggle("active", panel.getAttribute("data-copy-panel") === tab);
      });
      if (stage) {
        requestAnimationFrame(() => fitStage(stage));
      }
    }

    // 监听 iframe 内 postMessage
    window.addEventListener("message", (e) => {
      if (!e.data || e.data.type !== "xhs-nav") return;
      activateTab(e.data.tab, e.data.src);
    });

    // 初始默认显示 dashboard
    const firstPanel = showcase.querySelector("[data-copy-panel]");
    if (firstPanel) firstPanel.classList.add("active");
  }

  // ── 入屏动效（IntersectionObserver） ──
  const animEls = document.querySelectorAll(".reveal");
  if (animEls.length && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("revealed");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    animEls.forEach((el) => io.observe(el));
  }

  // ── 首页锚点在 snap 容器内滚动 ──
  if (snapMain) {
    document.querySelectorAll('a[href^="#"]').forEach((link) => {
      link.addEventListener("click", (e) => {
        const targetId = link.getAttribute("href");
        if (!targetId || targetId.length < 2) return;
        const target = document.querySelector(targetId);
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }
})();
