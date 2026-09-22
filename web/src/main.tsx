import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./themes/theme";

// 必须在渲染前挂上 data-theme，否则会先按默认色画一帧再变色（闪烁）
initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
