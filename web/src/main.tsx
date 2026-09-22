import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { applyLayout, initTheme, resolveLayout } from "./themes/theme";

// 必须在渲染前挂上 data-theme / data-layout，否则会先按默认值画一帧再变
// （颜色会闪一下，布局会跳一下）
initTheme();
applyLayout(resolveLayout());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
