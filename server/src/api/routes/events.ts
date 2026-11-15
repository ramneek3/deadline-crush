import { Router, type Response } from "express";
import { requireAuth, requireOrganizer, requireTeamMember } from "../../lib/auth";
import { subscribeEvents, type StatusEvent } from "../../lib/events";

export const eventsRouter = Router();

function openStream(res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
  const hb = setInterval(() => res.write(": ping\n\n"), 15_000);
  return () => clearInterval(hb);
}

/** Live status for one team: uploading -> queued -> checking -> accepted | needs_fix. */
eventsRouter.get("/events", requireAuth, requireTeamMember, (req, res) => {
  const teamId = req.user!.teamId!;
  const stop = openStream(res);
  res.write(`event: ready\ndata: {}\n\n`);
  const unsub = subscribeEvents((e: StatusEvent) => {
    if (e.teamId === teamId) res.write(`event: status\ndata: ${JSON.stringify(e)}\n\n`);
  });
  req.on("close", () => {
    stop();
    unsub();
  });
});

/** Organizer dashboard feed: a tick for every status change anywhere (client refetches stats). */
eventsRouter.get("/organizer/events", requireAuth, requireOrganizer, (req, res) => {
  const stop = openStream(res);
  res.write(`event: ready\ndata: {}\n\n`);
  let pending = false;
  const unsub = subscribeEvents((e) => {
    if (pending) return; // coalesce bursts into one tick per 500 ms
    pending = true;
    setTimeout(() => {
      pending = false;
      res.write(`event: status\ndata: ${JSON.stringify(e)}\n\n`);
    }, 500);
  });
  req.on("close", () => {
    stop();
    unsub();
  });
});
