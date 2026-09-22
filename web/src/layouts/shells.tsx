import {
  ControlBar,
  DeviceCards,
  DeviceChips,
  DeviceList,
  DeviceTable,
  DeviceTiles,
  EmptyDevices,
  FocusScreen,
  MetricCard,
  StatStrip,
  StatusPill,
  metaFields,
  metaGrid
} from "./pieces";
import type { ConsoleLayoutProps } from "./types";

/**
 * 五种**布局结构**（不是换色）。
 *
 * 差别在四处，任何一处不同都会让"怎么用"不一样：
 *   1. 导航在哪        顶部横幅 / 左侧竖栏
 *   2. 设备怎么表现    大卡片 / 行列表 / 数据表格 / 芯片 / 小砖块
 *   3. 画面占多大      半屏 / 主区大头 / 顶部横幅 / 近乎全屏
 *   4. 信息层级        大标题开场 / 直接上表格 / 状态条
 
 * 导航位置由 `App.tsx` 按 `layout` 决定（顶部或左栏），这里只管内容区。
 */

function statsOf(props: ConsoleLayoutProps) {
  return [
    { label: "已发现", value: String(props.devices.length).padStart(2, "0") },
    { label: "在线", value: String(props.onlineCount).padStart(2, "0") },
    { label: "TCP", value: String(props.tcpCount).padStart(2, "0") },
    {
      label: "画面",
      value:
        props.streamState === "live"
          ? "LIVE"
          : props.streamState === "connecting"
            ? "SYNC"
            : props.streamState === "error"
              ? "ERR"
              : "IDLE"
    }
  ];
}

/* ─────────────────────── 1. classic（经典）───────────────────────
 * 现状布局：顶部大标题 + 四张指标卡 → 下面两栏（左画面 / 右卡片墙）。
 * 作为基准不动，其余四套都与它明显不同。
 */
export function LayoutClassic(props: ConsoleLayoutProps) {
  if (props.devices.length === 0) {
    return <EmptyDevices />;
  }

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">外贸易</div>
          <h1>单设备实时控制</h1>
          <p>
            {props.canControl
              ? "你可以直接点击、拖动滑动，并使用系统按键操作 Android。"
              : "当前账号仅可查看画面，手动操控权限未开启。"}
          </p>
        </div>

        <div className="stats-grid">
          <MetricCard label="已发现设备" value={String(props.devices.length).padStart(2, "0")} hint="分配给你的设备" />
          <MetricCard label="在线设备" value={String(props.onlineCount).padStart(2, "0")} hint="当前可控制" />
          <MetricCard label="TCP 设备" value={String(props.tcpCount).padStart(2, "0")} hint="ADB over TCP" />
          <MetricCard
            label="视频状态"
            value={statsOf(props)[3].value}
            hint={props.streamMessage}
            accent={props.streamState !== "error"}
          />
        </div>
      </section>

      <section className="dashboard-grid">
        <article className="focus-panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">当前主选设备</div>
              <h2>{props.selectedDevice?.model ?? "暂无设备"}</h2>
            </div>
            <StatusPill status={props.selectedDevice?.status ?? "unknown"} />
          </div>

          <FocusScreen props={props} />
          <ControlBar props={props} />
          {metaGrid(metaFields(props))}
        </article>

        <section className="device-wall">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">设备卡片墙</div>
              <h2>我的设备</h2>
            </div>
            <div className="panel-note">{props.errorMessage || "点击任一设备切换实时主画面"}</div>
          </div>
          <DeviceCards props={props} />
        </section>
      </section>
    </>
  );
}

/* ─────────────────────── 2. master-detail（主从）───────────────────────
 * 结构变化：**导航移到左侧竖栏**（见 App.tsx），内容区变成三栏
 * —— 设备行列表 | 画面 | 元信息。
 * 没有大标题开场，指标压成侧栏底部的小计数；设备用**行列表**而不是卡片，
 * 一屏能扫到的设备数是卡片墙的 3 倍左右。
 */
export function LayoutMasterDetail(props: ConsoleLayoutProps) {
  if (props.devices.length === 0) {
    return <EmptyDevices />;
  }

  const fields = metaFields(props);

  return (
    <section className="md-shell">
      <aside className="md-list">
        <div className="md-list-head">
          <div>
            <div className="panel-kicker">设备</div>
            <h2 className="md-list-title">
              {props.onlineCount}/{props.devices.length} 在线
            </h2>
          </div>
        </div>
        <DeviceList props={props} showMeta />
        {props.errorMessage ? <div className="md-list-error">{props.errorMessage}</div> : null}
      </aside>

      <main className="md-stage">
        <div className="md-stage-head">
          <div>
            <div className="panel-kicker">当前设备</div>
            <h2 className="md-stage-title">{props.selectedDevice?.model ?? "暂无设备"}</h2>
            <div className="md-stage-sub">
              {props.selectedDevice?.serial ?? "-"} · {props.streamMessage}
            </div>
          </div>
          <StatusPill status={props.selectedDevice?.status ?? "unknown"} />
        </div>

        <FocusScreen props={props} variant="md" />
        <ControlBar props={props} />
      </main>

      <aside className="md-info">
        <div className="md-info-block">
          <div className="panel-kicker">设备信息</div>
          <dl className="md-info-list">
            {fields.map((field) => (
              <div key={field.label} className="md-info-row">
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <StatStrip items={statsOf(props)} />
      </aside>
    </section>
  );
}

/* ─────────────────────── 3. table（表格密集）───────────────────────
 * 结构变化：整个页面就是**一张设备表**（每台一行、八列），
 * 画面嵌在右侧固定栏里。适合一次管几十台机器 ——
 * 卡片的边框和内边距在设备多的时候纯属浪费纵向空间。
 */
export function LayoutTable(props: ConsoleLayoutProps) {
  if (props.devices.length === 0) {
    return <EmptyDevices />;
  }

  return (
    <section className="tbl-shell">
      <div className="tbl-top">
        <StatStrip items={statsOf(props)} />
      </div>

      <div className="tbl-body">
        <div className="tbl-main">
          <div className="tbl-main-head">
            <h2>设备清单</h2>
            <span className="panel-note">{props.errorMessage || "点任意一行切换右侧画面"}</span>
          </div>
          <DeviceTable props={props} />
        </div>

        <aside className="tbl-side">
          <div className="tbl-side-head">
            <div className="panel-kicker">画面</div>
            <h3>{props.selectedDevice?.model ?? "暂无设备"}</h3>
            <div className="md-stage-sub">{props.streamMessage}</div>
          </div>
          <FocusScreen props={props} variant="tbl" />
          <ControlBar props={props} />
          {metaGrid(metaFields(props).slice(0, 6), true)}
        </aside>
      </div>
    </section>
  );
}

/* ─────────────────────── 4. studio（工作台）───────────────────────
 * 结构变化：**画面优先** —— 左侧约 2/3 视口全是手机画面，右侧一条窄栏
 * 放设备芯片、元信息和控制。没有大标题、没有卡片墙，
 * 顶部只有一条极细的状态条。适合"就盯着一台机器操作"的用法。
 */
export function LayoutStudio(props: ConsoleLayoutProps) {
  if (props.devices.length === 0) {
    return <EmptyDevices />;
  }

  const fields = metaFields(props);

  return (
    <section className="std-shell">
      <header className="std-bar">
        <span className="std-bar-title">{props.selectedDevice?.model ?? "暂无设备"}</span>
        <StatusPill status={props.selectedDevice?.status ?? "unknown"} compact />
        <span className="std-bar-sep" />
        <StatStrip items={statsOf(props)} />
      </header>

      <div className="std-body">
        <div className="std-screen">
          <FocusScreen props={props} variant="std" />
        </div>

        <aside className="std-side">
          <DeviceChips props={props} />
          <ControlBar props={props} />

          <dl className="md-info-list">
            {fields.map((field) => (
              <div key={field.label} className="md-info-row">
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
    </section>
  );
}

/* ─────────────────────── 5. wall（设备墙）───────────────────────
 * 结构变化：**墙为主体**。顶部一条横幅放当前设备的画面（扁的），
 * 下面整片区域是又小又密的设备砖块墙（6~10 列），一眼看完有没有掉线。
 * 层级与经典布局正好相反：经典是"画面为主、墙为辅"，这里是"墙为主、
 * 画面当预览条"。
 */
export function LayoutWall(props: ConsoleLayoutProps) {
  if (props.devices.length === 0) {
    return <EmptyDevices />;
  }

  return (
    <section className="wall-shell">
      <header className="wall-banner">
        <div className="wall-banner-screen">
          <FocusScreen props={props} variant="wall" />
        </div>

        <div className="wall-banner-info">
          <div className="panel-kicker">当前预览</div>
          <h2>{props.selectedDevice?.model ?? "暂无设备"}</h2>
          <div className="md-stage-sub">{props.selectedDevice?.serial ?? "-"}</div>
          <ControlBar props={props} />
        </div>
      </header>

      <div className="wall-body">
        <div className="wall-body-head">
          <h2>设备墙</h2>
          <StatStrip items={statsOf(props)} />
        </div>
        <DeviceTiles props={props} />
      </div>
    </section>
  );
}

export type ConsoleLayoutId = "classic" | "master-detail" | "table" | "studio" | "wall";

/** 布局分发。逻辑全部来自 ConsoleView，这里只决定怎么摆。 */
export function ConsoleLayout({ layout, ...props }: ConsoleLayoutProps & { layout: ConsoleLayoutId }) {
  switch (layout) {
    case "master-detail":
      return <LayoutMasterDetail {...props} />;
    case "table":
      return <LayoutTable {...props} />;
    case "studio":
      return <LayoutStudio {...props} />;
    case "wall":
      return <LayoutWall {...props} />;
    case "classic":
    default:
      return <LayoutClassic {...props} />;
  }
}
