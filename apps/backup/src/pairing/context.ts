import { appSecret } from "@/auth/auth";
import { restBaseUrl, restDir, serverName, tlsCaPem } from "@/settings";
import { retentionFromEnv } from "@schulos/server/backup-retention";
import type { PairingContext } from "./service";

export function pairingContext(): PairingContext {
  return { appSecret: appSecret(), caPem: tlsCaPem(), serverName: serverName(), restDir: restDir(), restBaseUrl: restBaseUrl(), retention: retentionFromEnv(process.env) };
}
