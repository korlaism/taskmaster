import { Router } from "express";
import type { LocalSimTeamsClient } from "./local-sim-client.js";

/**
 * Dev-only surface: lets a person (or a test/curl) see what card would have been sent
 * to a given user/channel in local-sim mode, standing in for opening Teams. Mounted
 * only when TEAMS_ADAPTER_MODE=local-sim (see src/api.ts).
 */
export function createLocalSimRouter(client: LocalSimTeamsClient): Router {
  const router = Router();

  router.get("/local-sim/cards/:subjectId", (req, res) => {
    const card = client.getLastCard(req.params.subjectId);
    if (!card) {
      res.status(404).json({ error: "no card delivered to this subject yet" });
      return;
    }
    res.json(card);
  });

  return router;
}
