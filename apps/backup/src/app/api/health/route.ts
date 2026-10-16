import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { health } from "@/lib/health";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

export async function GET() {
  let up = true;
  try {
    await (await getDb()).execute(sql`select 1`);
  } catch (err) {
    console.error("[health]", err);
    up = false;
  }
  return Response.json(health(pkg.version, up), { status: up ? 200 : 503 });
}
