// @ts-check
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // CDP witnesses require Chromium.
  projects: [{ name: "chromium" }],
  // Policy: leave headroom for increased FC_NUM_RUNS.
  timeout: 90_000,
  // Policy: bound individual browser actions.
  use: {
    actionTimeout: 15_000,
    // Tests connect to an ephemeral self-signed server.
    ignoreHTTPSErrors: true,
  },
});
