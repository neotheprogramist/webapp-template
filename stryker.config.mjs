// @ts-check
export default {
  testRunner: "command",
  commandRunner: { command: "npx playwright test tests/schema.spec.mjs" },
  mutate: ["web/src/content.schema.mjs"],
  // The command runner cannot attribute individual tests to mutants.
  coverageAnalysis: "off",
  // Policy: allow one Playwright startup per mutant.
  timeoutMS: 120000,
  timeoutFactor: 10,
  thresholds: { break: 100 },
};
