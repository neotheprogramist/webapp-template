// @ts-check
import { X509Certificate } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { connect } from "node:tls";
import { test, expect } from "@playwright/test";
import {
  exited,
  generateCertPair,
  removeCertDir,
  spawnServer,
  withCapturedServer,
} from "./utils/server.mjs";

test.describe("TLS source", () => {
  test("a PEM cert/key pair is served verbatim on the wire", async ({ request }) => {
    await withCapturedServer(async ({ url, certPath }) => {
      const res = await request.get(`${url}/`);
      expect(res.status()).toBe(200);

      const expected = new X509Certificate(await readFile(certPath)).fingerprint256;
      const { hostname, port } = new URL(url);
      const host = hostname.replace(/^\[|\]$/g, "");
      const presented = await new Promise((resolve, reject) => {
        // PROOF: rejectUnauthorized:false is safe and required here — the peer is ::1
        // presenting a self-signed cert that can never chain-verify; the fingerprint equality
        // asserted below pins the exact certificate, which is stronger than chain verification.
        const socket = connect({ host, port: Number(port), rejectUnauthorized: false }, () => {
          resolve(socket.getPeerCertificate().fingerprint256);
          socket.end();
        });
        socket.on("error", reject);
      });
      expect(presented).toBe(expected);
    });
  });

  test("supplying either half of the TLS pair missing or empty fails fast at startup", async () => {
    const { dir, certPath, keyPath } = await generateCertPair();
    try {
      const halves = [
        { env: "APP_TLS_CERT", flag: "--tls-cert", path: certPath },
        { env: "APP_TLS_KEY", flag: "--tls-key", path: keyPath },
      ];
      const invalid = halves.flatMap((withheld) => {
        const supplied = halves.filter((half) => half !== withheld);
        return ["dropped", "emptied"].map((how) => ({
          named: withheld.flag,
          label: `${withheld.flag} ${how}`,
          env: Object.fromEntries([
            ...supplied.map((half) => [half.env, half.path]),
            ...(how === "emptied" ? [[withheld.env, ""]] : []),
          ]),
        }));
      });
      expect(invalid, "two halves × two ways to withhold one").toHaveLength(4);
      await Promise.all(
        invalid.map(async ({ env, named, label }) => {
          const child = spawnServer(env);
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
          });
          const code = await exited(child);
          expect(code, `${label}: ${stderr}`).not.toBe(0);
          expect(stderr, label).toContain(named);
        }),
      );
    } finally {
      await removeCertDir(dir);
    }
  });

  test("regression: a malformed private key reports the key path", async () => {
    const { dir, certPath, keyPath } = await generateCertPair();
    try {
      await writeFile(keyPath, "not a private key");
      const child = spawnServer({ APP_TLS_CERT: certPath, APP_TLS_KEY: keyPath });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      expect(await exited(child), stderr).not.toBe(0);
      expect(stderr).toContain(keyPath);
    } finally {
      await removeCertDir(dir);
    }
  });
});
