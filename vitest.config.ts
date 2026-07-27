import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./test/support/test-db-config.js";

export default defineConfig({
  test: {
    globalSetup: ["./test/support/global-setup.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // One PGlite instance backs every test in the run (see global-setup.ts) — running
    // files in separate parallel workers would each need their own instance.
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      ORG_ID: "00000000-0000-0000-0000-0000000000aa",
      ORG_TIMEZONE: "America/New_York",
      ORG_DEFAULT_REMINDER_TIME: "09:00",
      ORG_DEFAULT_CUTOFF_TIME: "16:00",
      ORG_DEFAULT_DIGEST_PUBLISH_TIME: "17:00",
    },
  },
});
