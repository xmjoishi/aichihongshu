(() => {
  const STAGE_WIDTH = 1180;
  const STAGE_HEIGHT = 720;

  function fitStage(stage) {
    const fit = stage.querySelector("[data-preview-fit]");
    if (!fit) return;
    const scale = Math.min(stage.clientWidth / STAGE_WIDTH, stage.clientHeight / STAGE_HEIGHT);
    fit.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }

  function activateShowcase(showcase, tab) {
    const triggers = showcase.querySelectorAll("[data-product-tab]");
    const frame = showcase.querySelector("[data-preview-frame]");
    const panels = showcase.querySelectorAll("[data-copy-panel]");

    triggers.forEach((node) => {
      const active = node.getAttribute("data-product-tab") === tab;
      node.classList.toggle("active", active);
      if (node.classList.contains("showcase-tab")) {
        node.setAttribute("aria-selected", active ? "true" : "false");
      }
      if (active && frame) {
        const nextSrc = node.getAttribute("data-preview-src");
        if (nextSrc && frame.getAttribute("src") !== nextSrc) {
          frame.setAttribute("src", nextSrc);
        }
      }
    });

    panels.forEach((panel) => {
      panel.classList.toggle("active", panel.getAttribute("data-copy-panel") === tab);
    });
  }

  const showcases = document.querySelectorAll("[data-showcase]");
  showcases.forEach((showcase) => {
    const defaultTrigger = showcase.querySelector(".showcase-tab.active") || showcase.querySelector(".showcase-tab");
    const defaultTab = defaultTrigger ? defaultTrigger.getAttribute("data-product-tab") : null;

    showcase.querySelectorAll("[data-product-tab]").forEach((node) => {
      if (!node.classList.contains("showcase-tab")) return;
      node.addEventListener("click", () => {
        const tab = node.getAttribute("data-product-tab");
        if (tab) activateShowcase(showcase, tab);
      });
    });

    if (defaultTab) activateShowcase(showcase, defaultTab);
  });

  function fitAllStages() {
    document.querySelectorAll("[data-preview-stage]").forEach(fitStage);
  }

  window.addEventListener("resize", fitAllStages, { passive: true });
  fitAllStages();
})();
