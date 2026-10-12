import db from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { klaviyoEnabled } from "../klaviyo/client.server";
import { processJobs } from "./klaviyo-sync.server";
import { summarizeError } from "./backoff";
import { KIND, claimDueJobs, failJob } from "./outbox.server";

/**
 * Background delivery of the outbox, one loop per app process.
 *
 * Runs in the app itself rather than as a separate service so it ships with
 * every blue/green release; concurrent slots are safe because claiming is
 * exclusive per row. A tick every 15 s catches retries and anything enqueued
 * by another process; `kickSyncWorker()` makes fresh redemptions go out
 * within a second.
 */

const TICK_MS = 15_000;
const KICK_DELAY_MS = 500;
const BATCH = 20;
// 02:00 WIB (UTC+7): after the day's orders, before the morning's campaigns.
const RESYNC_HOUR_WIB = 2;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const state = (global.__syncWorker ??= {
  started: false,
  running: false,
  again: false,
  timer: null,
  kick: null,
});

function wibNow() {
  const shifted = new Date(Date.now() + WIB_OFFSET_MS);
  return {
    day: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
  };
}

/** Queues tonight's full resync once per shop; the unique key makes it once across slots. */
async function scheduleNightlyResync() {
  const { day, hour } = wibNow();
  if (hour < RESYNC_HOUR_WIB) return;
  const shops = await db.discountCampaign.findMany({
    distinct: ["shop"],
    select: { shop: true },
  });
  if (!shops.length) return;
  await db.syncJob.createMany({
    data: shops.map(({ shop }) => ({
      shop,
      kind: KIND.resync,
      dedupeKey: `resync:${day}`,
    })),
    skipDuplicates: true,
  });
}

async function tick() {
  if (state.running) {
    // Something was enqueued mid-drain; go round once more when this one ends.
    state.again = true;
    return;
  }
  state.running = true;
  state.again = false;
  try {
    await scheduleNightlyResync();
    // Drain what is due now, batch by batch, then go back to sleep.
    for (let round = 0; round < 50; round += 1) {
      const jobs = await claimDueJobs(BATCH);
      if (!jobs.length) break;

      const byShop = Object.groupBy(jobs, (j) => j.shop);
      for (const [shop, shopJobs] of Object.entries(byShop)) {
        let admin;
        try {
          ({ admin } = await unauthenticated.admin(shop));
        } catch (error) {
          // No offline session (uninstalled): park the jobs until a reinstall.
          for (const job of shopJobs) await failJob(job, error);
          continue;
        }
        await processJobs(admin, shop, shopJobs);
      }
      console.log(
        `[sync] processed ${jobs.length} job(s): ` +
          Object.entries(Object.groupBy(jobs, (j) => j.kind))
            .map(([k, v]) => `${k}×${v.length}`)
            .join(", "),
      );
    }
  } catch (error) {
    // The DB itself is unreachable; leases expire and the next tick retries.
    console.error("[sync] tick failed:", summarizeError(error));
  } finally {
    state.running = false;
    if (state.again) kickSyncWorker();
  }
}

/** Starts the loop once per process. A no-op without a Klaviyo key. */
export function startSyncWorker() {
  if (state.started) return;
  state.started = true;
  if (!klaviyoEnabled()) {
    console.log("[sync] KLAVIYO_PRIVATE_API_KEY not set; Klaviyo sync is off");
    return;
  }
  state.timer = setInterval(tick, TICK_MS);
  state.timer.unref?.();
  setTimeout(tick, 2_000).unref?.();
  console.log("[sync] Klaviyo sync worker started");
}

/** Asks for a drain soon; repeated calls within the delay collapse into one. */
export function kickSyncWorker() {
  if (!state.started || !state.timer || state.kick) return;
  state.kick = setTimeout(() => {
    state.kick = null;
    tick();
  }, KICK_DELAY_MS);
  state.kick.unref?.();
}
