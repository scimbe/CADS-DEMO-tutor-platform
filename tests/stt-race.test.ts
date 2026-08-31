import { createServer } from "node:http";
import type { Server } from "node:http";
import { transcribeRace, TranscribeRaceError } from "../src/stt-race.js";

/** A fake whisper-service: responds after `delayMs`, with `text` or a 500 error. */
function fakeService(opts: { delayMs: number; text?: string; fail?: boolean; expectAuth?: string }): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      setTimeout(() => {
        if (opts.expectAuth && req.headers["authorization"] !== opts.expectAuth) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (opts.fail) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "synthetic failure" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: opts.text ?? "ok" }));
      }, opts.delayMs);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeAll(servers: Server[]): Promise<void[]> {
  return Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
}

describe("transcribeRace", () => {
  test("returns the fastest endpoint's result", async () => {
    const fast = await fakeService({ delayMs: 20, text: "fast wins" });
    const slow = await fakeService({ delayMs: 300, text: "slow loses" });

    const result = await transcribeRace(Buffer.from("audio"), [
      { url: slow.url, label: "slow" },
      { url: fast.url, label: "fast" },
    ]);

    expect(result.text).toBe("fast wins");
    expect(result.wonBy).toBe("fast");

    await closeAll([fast.server, slow.server]);
  });

  test("tolerates a failing endpoint and still returns the succeeding one", async () => {
    const broken = await fakeService({ delayMs: 10, fail: true });
    const working = await fakeService({ delayMs: 60, text: "still works" });

    const result = await transcribeRace(Buffer.from("audio"), [
      { url: broken.url, label: "broken" },
      { url: working.url, label: "working" },
    ]);

    expect(result.text).toBe("still works");
    expect(result.wonBy).toBe("working");

    await closeAll([broken.server, working.server]);
  });

  test("throws TranscribeRaceError with every failure when all endpoints fail", async () => {
    const a = await fakeService({ delayMs: 5, fail: true });
    const b = await fakeService({ delayMs: 15, fail: true });

    await expect(
      transcribeRace(Buffer.from("audio"), [
        { url: a.url, label: "a" },
        { url: b.url, label: "b" },
      ])
    ).rejects.toThrow(TranscribeRaceError);

    await closeAll([a.server, b.server]);
  });

  test("sends the configured Authorization header", async () => {
    const authed = await fakeService({ delayMs: 5, text: "authed", expectAuth: "Bearer secret-key" });

    const result = await transcribeRace(Buffer.from("audio"), [{ url: authed.url, apiKey: "secret-key" }]);

    expect(result.text).toBe("authed");

    await closeAll([authed.server]);
  });

  test("rejects immediately for an empty endpoint list", async () => {
    await expect(transcribeRace(Buffer.from("audio"), [])).rejects.toThrow(/at least one endpoint/);
  });
});
