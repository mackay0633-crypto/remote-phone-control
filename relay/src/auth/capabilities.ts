/**
 * 权限开关的唯一定义源。
 *
 * 挂在使用者账号上（不是租户）：一个客户一个账号，
 * 两周后客户离开就把开关归零、设备收回即可。
 *
 * 新增能力 = 在 CAPABILITIES 里加一项 + 在 users 表加一列。
 */

export const CAPABILITIES = [
  "can_view_devices",
  "can_view_stream",
  "can_control_input",
  "can_run_dayil",
  "can_send_video",
  "can_upload_video"
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** 供管理页面渲染勾选框使用 */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  can_view_devices: "查看设备列表",
  can_view_stream: "查看实时画面",
  can_control_input: "手动操控（点击 / 滑动 / 按键）",
  can_run_dayil: "下发养号任务",
  can_send_video: "下发发视频任务",
  can_upload_video: "上传视频素材"
};

/**
 * 基础能力：关掉它，其余能力全部失去意义。
 * 服务端在执行任何设备相关操作前都应先检查它。
 */
export const BASE_CAPABILITY: Capability = "can_view_devices";

export type CapabilitySet = Record<Capability, boolean>;

/** 全关 —— 新注册客户的默认状态 */
export function noCapabilities(): CapabilitySet {
  return {
    can_view_devices: false,
    can_view_stream: false,
    can_control_input: false,
    can_run_dayil: false,
    can_send_video: false,
    can_upload_video: false
  };
}

/** 全开 —— 管理员账号使用 */
export function allCapabilities(): CapabilitySet {
  return {
    can_view_devices: true,
    can_view_stream: true,
    can_control_input: true,
    can_run_dayil: true,
    can_send_video: true,
    can_upload_video: true
  };
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}
