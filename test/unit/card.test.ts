import { describe, expect, it } from "vitest";
import { parseCardSubmission } from "../../src/modules/daily-updates/card.js";

describe("parseCardSubmission", () => {
  const base = {
    cycleId: "cycle-1",
    userId: "user-1",
    idempotencyKey: "key-1",
    intent: "submit",
    completedToday: "Shipped the thing",
    inProgress: "",
    blockers: "",
    nextPlanned: "",
    reviewRequired: "false",
    additionalNotes: "",
    skipReason: "",
    additionalTicket: "",
  };

  it("includes only tickets toggled true, plus a manually-added ticket", () => {
    const input = parseCardSubmission({
      ...base,
      "ticket_SIM40-1": "true",
      "ticket_SIM40-2": "false",
      additionalTicket: "sim40-99",
    });
    expect(input.jiraIssueKeys?.sort()).toEqual(["SIM40-1", "SIM40-99"].sort());
  });

  it("marks the submission as 'skipped' when a skip reason is provided, regardless of intent", () => {
    const input = parseCardSubmission({ ...base, intent: "submit", skipReason: "On PTO" });
    expect(input.status).toBe("skipped");
    expect(input.skipReason).toBe("On PTO");
  });

  it("maps intent=draft to status='draft' when no skip reason is given", () => {
    const input = parseCardSubmission({ ...base, intent: "draft" });
    expect(input.status).toBe("draft");
  });

  it("maps intent=submit to status='submitted'", () => {
    const input = parseCardSubmission({ ...base, intent: "submit" });
    expect(input.status).toBe("submitted");
  });

  it("carries the idempotency key through unchanged", () => {
    const input = parseCardSubmission({ ...base, idempotencyKey: "abc-123" });
    expect(input.idempotencyKey).toBe("abc-123");
  });
});
