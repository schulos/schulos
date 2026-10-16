import { getAuth } from "@/core/auth/auth";

export const dynamic = "force-dynamic";

async function handler(req: Request) {
  return (await getAuth()).handler(req);
}

export { handler as GET, handler as POST };
