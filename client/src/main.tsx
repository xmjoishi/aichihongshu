import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./index.css";

// 在 React 渲染前立即初始化 HDR attribute，避免首帧闪烁
;(function initHDR() {
  let hdr = false;
  try { hdr = localStorage.getItem("hdr_display") === "true"; } catch { /* ignore */ }
  document.documentElement.setAttribute("data-hdr", hdr ? "on" : "off");
})();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
