// Device keys for the simulated device. Secret keys live outside the repo in $POURPROOF_SECRETS/devices/<pour>.json
// (file mode 600); only the public key (qx, qy) ever goes into repo files or on chain.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { p256 } from "@noble/curves/nist.js";
import { fromHex, pourIdOf, publicKeyOf, toHex, type Hex, type PublicKey } from "@pourproof/core";

export type DeviceKind = "esp32" | "simulated";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Default secrets folder: the project's secrets/ next to the repo, never inside it. */
export const DEFAULT_SECRETS_DIR = resolve(REPO_ROOT, "..", "..", "secrets");

export interface DeviceKeyFile extends PublicKey {
  format: "pourproof.device-key/1";
  pourLabel: string;
  pourId: Hex;
  deviceKind: DeviceKind;
  curve: "P-256";
  secretKey: Hex;
  createdAt: string;
}

export interface DeviceKey extends PublicKey {
  pourLabel: string;
  deviceKind: DeviceKind;
  secretKey: Uint8Array;
}

export function secretsDir(env: NodeJS.ProcessEnv = process.env): string {
  return outsideRepo(env.POURPROOF_SECRETS || DEFAULT_SECRETS_DIR);
}

function outsideRepo(d: string): string {
  const dir = resolve(d);
  const rel = relative(REPO_ROOT, dir);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) {
    throw new Error(`refusing to keep device keys inside the repo (${dir}); set POURPROOF_SECRETS to a folder outside it`);
  }
  return dir;
}

export function deviceKeyPath(pourLabel: string, dir = secretsDir()): string {
  if (!/^[A-Za-z0-9_-]+$/.test(pourLabel)) throw new Error(`bad pour label: ${pourLabel}`);
  return join(outsideRepo(dir), "devices", `${pourLabel}.json`);
}

/** Creates a fresh P-256 key for one pour's simulated device. Refuses to overwrite unless `force`. */
export function keygen(pourLabel: string, opts: { dir?: string; force?: boolean } = {}): { path: string; key: PublicKey } {
  const path = deviceKeyPath(pourLabel, opts.dir ?? secretsDir());
  if (existsSync(path) && !opts.force) throw new Error(`${path} exists; pass --force to replace the device key`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const sk = p256.utils.randomSecretKey();
  const pub = publicKeyOf(sk);
  const file: DeviceKeyFile = {
    format: "pourproof.device-key/1",
    pourLabel,
    pourId: pourIdOf(pourLabel),
    deviceKind: "simulated",
    curve: "P-256",
    secretKey: toHex(sk),
    ...pub,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, key: pub };
}

/** Loads a device key; refuses files readable by group or others, and keys that do not match their stored public key. */
export function loadDeviceKey(pourLabel: string, opts: { dir?: string } = {}): DeviceKey {
  const path = deviceKeyPath(pourLabel, opts.dir ?? secretsDir());
  if (!existsSync(path)) throw new Error(`no device key at ${path}; run: npm run keygen -w packages/device -- ${pourLabel}`);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} has mode ${mode.toString(8)}; device keys must be 600`);
  const f = JSON.parse(readFileSync(path, "utf8")) as DeviceKeyFile;
  const sk = fromHex(f.secretKey);
  const pub = publicKeyOf(sk);
  if (pub.qx !== f.qx || pub.qy !== f.qy) throw new Error(`${path}: public key does not match the secret key`);
  if (f.pourLabel !== pourLabel) throw new Error(`${path}: key belongs to ${f.pourLabel}`);
  return { pourLabel, deviceKind: f.deviceKind, secretKey: sk, ...pub };
}
