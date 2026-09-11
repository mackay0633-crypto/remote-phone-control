/**
 * autojs-controller 自动化接口的类型定义。
 *
 * 对应其 API_AUTOMATION.md，以及 server.js 中的实际实现。
 * 注意：autojs 没有租户概念，它的响应是全局视图，
 * 因此这里只做「调用 + 输入校验」，不承担任何隔离职责。
 */

export interface DayilWorkConfig {
  SWIPE_COUNT?: number;
  PLAY_DURATION?: number;
  LIKE_PROBABILITY?: number;
  FOLLOW_PROBABILITY?: number;
  [key: string]: unknown;
}

export interface StartDayilWorkInput {
  device_ids: string[];
  config?: DayilWorkConfig;
}

export interface BatchAssignment {
  account: string;
  video: string;
}

export interface StartSendVideoInput {
  type?: "precise" | "batch";
  accounts: string[];
  /** Windows 主机上的本地绝对路径（autojs 需要它来 adb push） */
  video_paths: string[];
  /** 可选；不传时 autojs 会从 video_paths 的 basename 推导 */
  videos?: string[];
  send_time?: string;
  titles?: string[];
  product_name?: string;
  location?: string;
  device_ids?: string[];
  assignments?: BatchAssignment[];
}

export interface AutojsPushResultItem {
  type?: string;
  device?: string;
  account?: string;
  file?: string;
  success: boolean;
  error?: string;
  remotePath?: string;
}

export interface AutojsActionResult {
  success: boolean;
  error?: string;
  message?: string;
  script_path?: string;
  script_run_id?: string;
  script_type?: string;
  resolved_videos?: string[];
  resolved_device_ids?: string[];
  device_accounts?: Record<string, string[]>;
  account_video_paths?: Record<string, string[]>;
  push_result?: {
    success: boolean;
    remoteScript?: string;
    results?: AutojsPushResultItem[];
  };
  run_result?: {
    success: boolean;
    message?: string;
    results?: { device: string; success: boolean; method?: string; error?: string }[];
  };
}

export interface AutojsRunStatusEntry {
  id: string;
  label: string;
  source: string;
  deviceId: string;
  scriptRunId: string;
  deviceCount: number;
  startedAt: number;
  expiresAt: number;
}

export interface AutojsRunStatus {
  success?: boolean;
  active: boolean;
  taskCount: number;
  runCount: number;
  deviceCount: number;
  latestLabel?: string;
  latestSource?: string;
  latestStartedAt?: number;
  entries: AutojsRunStatusEntry[];
}

export interface AutojsAccount {
  id: number | string;
  username: string;
  folder_path?: string;
  status?: string;
  device_id?: string | null;
}
