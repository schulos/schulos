// `rclone obscure` nachgebaut: rclone erwartet Passwörter in RCLONE_CONFIG_*_PASS verschleiert (nicht verschlüsselt – der
// Schlüssel steht im rclone-Quelltext, fs/config/obscure). So schreibt der Installer backup.env, ohne rclone aufzurufen.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d, 0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b, 0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb, 0xf4, 0xde,
  0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
]);

export function rcloneObscure(plain: string, iv: Buffer = randomBytes(16)): string {
  const c = createCipheriv("aes-256-ctr", KEY, iv);
  return Buffer.concat([iv, c.update(plain, "utf8"), c.final()]).toString("base64url");
}

export function rcloneReveal(obscured: string): string {
  const buf = Buffer.from(obscured, "base64url");
  const d = createDecipheriv("aes-256-ctr", KEY, buf.subarray(0, 16));
  return Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString("utf8");
}
