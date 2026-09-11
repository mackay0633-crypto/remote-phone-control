import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/**
 * scrypt 参数。
 *
 * N=16384 / r=8 / p=1 是 Node 官方文档给出的常用取值，
 * 在「足够慢以抵抗离线爆破」与「登录时不至于卡顿」之间取平衡（约几十毫秒）。
 */
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

const PREFIX = "scrypt";

/**
 * 生成密码哈希。
 *
 * 存储格式：`scrypt$N$r$p$<salt base64>$<hash base64>`
 * 参数随哈希一起保存，将来调整强度时旧密码仍然可以校验。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);

  return [
    PREFIX,
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64")
  ].join("$");
}

/**
 * 校验密码。
 *
 * 使用 timingSafeEqual 做恒定时间比较，避免通过响应时间推断哈希前缀。
 * 任何格式异常一律返回 false，不抛错——调用方不该因为脏数据而 500。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== PREFIX) {
      return false;
    }

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");

    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length === 0) {
      return false;
    }

    const derived = await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_PARAMS.maxmem
    });

    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** 生成高强度随机密码，用于初始管理员与随机重置。 */
export function generatePassword(length = 24): string {
  // 排除易混字符 0 O 1 l I
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*-_=+";
  const bytes = randomBytes(length);
  let out = "";

  for (let index = 0; index < length; index++) {
    out += alphabet[bytes[index] % alphabet.length];
  }

  return out;
}
