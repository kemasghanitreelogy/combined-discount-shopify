import prisma from "../db.server";

// Liveness + readiness probe for the deploy script. It touches the database
// because an app that can't reach Postgres can't load a single session, so
// "the process is up" alone would let a broken release pass. nginx refuses
// this path from outside; the deploy script calls it on 127.0.0.1 directly.
export const loader = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("healthz: database unreachable", error);
    return Response.json(
      { ok: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
