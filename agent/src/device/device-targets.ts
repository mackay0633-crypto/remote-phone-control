/**
 * 设备目标（ADB over TCP 地址）解析。
 *
 * 支持以下写法，可用逗号分隔多个条目：
 *
 *   "10.0.0.41-60"              末段范围      -> 10.0.0.41 ... 10.0.0.60
 *   "10.0.0.41-10.0.0.60"       完整 IP 范围  -> 同上
 *   "10.0.0.41"                 单个地址
 *   "10.0.0.41:5555"            带端口
 *   "10.0.0.41-60:65535"        范围 + 端口
 *
 * 条目未显式带端口时，使用 defaultPort。
 */

/** 展开上限，避免配置写错时生成海量目标。 */
const MAX_TARGETS = 1024;

export function parseDeviceTargets(spec: string, defaultPort: number): string[] {
  const targets: string[] = [];

  for (const rawEntry of spec.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }

    const withPort = entry.match(/^(.*):(\d+)$/);
    const base = withPort ? withPort[1].trim() : entry;
    const port = withPort ? Number(withPort[2]) : defaultPort;

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.warn(`[agent] ignore device target with invalid port: ${entry}`);
      continue;
    }

    const separatorIndex = base.indexOf("-");
    if (separatorIndex <= 0) {
      const ip = base.trim();
      if (!isValidIPv4(ip)) {
        console.warn(`[agent] ignore invalid device target: ${entry}`);
        continue;
      }
      targets.push(`${ip}:${port}`);
      continue;
    }

    const startText = base.slice(0, separatorIndex).trim();
    const endText = base.slice(separatorIndex + 1).trim();

    for (const ip of expandRange(startText, endText, entry)) {
      targets.push(`${ip}:${port}`);
    }
  }

  const unique = [...new Set(targets)];

  if (unique.length > MAX_TARGETS) {
    console.warn(`[agent] device target count ${unique.length} exceeds ${MAX_TARGETS}, truncating`);
    return unique.slice(0, MAX_TARGETS);
  }

  return unique;
}

function expandRange(startText: string, endText: string, original: string): string[] {
  const result: string[] = [];

  // 形式一：完整 IP - 完整 IP
  if (endText.includes(".")) {
    const startValue = ipToInt(startText);
    const endValue = ipToInt(endText);

    if (startValue === null || endValue === null || endValue < startValue) {
      console.warn(`[agent] ignore invalid device range: ${original}`);
      return result;
    }

    for (let value = startValue; value <= endValue; value++) {
      result.push(intToIp(value));
    }

    return result;
  }

  // 形式二：末段范围，例如 192.168.9.41-60
  const lastDot = startText.lastIndexOf(".");
  if (lastDot <= 0 || !isValidIPv4(startText)) {
    console.warn(`[agent] ignore invalid device range: ${original}`);
    return result;
  }

  const prefix = startText.slice(0, lastDot + 1);
  const startOctet = Number(startText.slice(lastDot + 1));
  const endOctet = Number(endText);

  if (!Number.isInteger(startOctet) || !Number.isInteger(endOctet) || startOctet > endOctet || endOctet > 255) {
    console.warn(`[agent] ignore invalid device range: ${original}`);
    return result;
  }

  for (let octet = startOctet; octet <= endOctet; octet++) {
    result.push(`${prefix}${octet}`);
  }

  return result;
}

function isValidIPv4(value: string): boolean {
  return ipToInt(value) !== null;
}

function ipToInt(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }

    const octet = Number(part);
    if (octet < 0 || octet > 255) {
      return null;
    }

    result = result * 256 + octet;
  }

  return result;
}

function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}
