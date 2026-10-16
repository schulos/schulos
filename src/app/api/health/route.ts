import { sql } from "drizzle-orm";
import { getDb } from "@/core/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, db: "up" });
  } catch (err) {
    console.error("[health]", err);
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
