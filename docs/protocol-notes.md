# scrcpy 协议笔记

基于官方开发文档与源码确认：

- scrcpy 由 PC 侧 client 和 Android 侧 `scrcpy-server` 组成
- 视频、音频、控制使用独立 socket
- 视频默认是 `H.264`
- scrcpy client 并不提供可依赖的 `--stdout` 视频输出接口

## 对项目的意义

- 最终方案不应建立在窗口截图上
- Agent 后续应直接与 `scrcpy-server` 协议对接
- 第一版可以先接收 scrcpy framing 后的视频数据，再桥接到浏览器

## 已确认的方向

- 浏览器侧媒体：`WebRTC`
- 本地 signaling：`WebSocket`
- 控制链路先走 `WebSocket`
- 后续可再并入 `WebRTC DataChannel`
