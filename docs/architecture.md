# 架构确认

## 第一阶段目标

先跑通：

```text
Android -> ADB / scrcpy -> Windows Agent -> Local Web -> Browser
```

第一阶段暂不接入 VPS，不做公网转发。

## 模块划分

### agent

- `config` 路径与端口配置
- `adb` ADB 命令封装
- `device` 设备发现与设备元数据抽象
- `scrcpy` 后续接入 scrcpy server / socket
- `stream` 后续做视频桥接
- `webrtc` 后续做本机 WebRTC 媒体协商

### web

- `Dashboard` 本地设备卡片页
- 后续接 WebSocket signaling
- 后续接 WebRTC 播放与输入映射

## 当前确认

- 设备模型必须从第一版就支持多设备
- `USB` 与 `ADB over TCP` 统一抽象为同类设备
- 不依赖 scrcpy GUI 窗口截图作为最终方案
- 后续视频链路优先直接读取 scrcpy 视频 socket
