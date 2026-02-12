import { createServer } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { GatewayClient, type GatewayClientMetrics } from "./client.js";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Create a minimal WS server that accepts connect and responds with hello-ok,
 * then handles request/response pairs.
 */
function setupWss(
  wss: WebSocketServer,
  handler?: (method: string, params: unknown) => { ok: boolean; payload?: unknown; error?: string },
) {
  wss.on("connection", (socket) => {
    let connected = false;
    socket.on("message", (data) => {
      const msg = JSON.parse(rawDataToString(data)) as {
        type: string;
        id: string;
        method?: string;
        params?: unknown;
      };

      if (!connected) {
        // Respond to connect with hello-ok.
        connected = true;
        const helloOk = {
          type: "hello-ok",
          protocol: 2,
          server: { version: "dev", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {
            presence: [],
            health: {},
            stateVersion: { presence: 1, health: 1 },
            uptimeMs: 1,
          },
          policy: {
            maxPayload: 512 * 1024,
            maxBufferedBytes: 1024 * 1024,
            tickIntervalMs: 30_000,
          },
        };
        socket.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: helloOk }));
        return;
      }

      // Handle subsequent requests.
      if (handler) {
        const result = handler(msg.method ?? "", msg.params);
        socket.send(JSON.stringify({ type: "res", id: msg.id, ...result }));
      } else {
        socket.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: {} }));
      }
    });
  });
}

describe("GatewayClient metrics", () => {
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    if (wss) {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss?.close(() => resolve()));
      wss = null;
    }
  });

  test("calls onRequestStart and onRequestSuccess on successful request", async () => {
    const port = await getFreePort();
    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    setupWss(wss, () => ({ ok: true, payload: { result: "ok" } }));

    const metrics: GatewayClientMetrics = {
      onRequestStart: vi.fn(),
      onRequestSuccess: vi.fn(),
      onRequestError: vi.fn(),
    };

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      metrics,
    });

    const connected = new Promise<void>((resolve) => {
      client.start();
      const original = client["opts"].onHelloOk;
      client["opts"].onHelloOk = (hello) => {
        original?.(hello);
        resolve();
      };
    });

    await connected;
    await client.request("test.method", { foo: "bar" });

    expect(metrics.onRequestStart).toHaveBeenCalledTimes(1);
    expect(metrics.onRequestStart).toHaveBeenCalledWith(
      expect.objectContaining({ method: "test.method" }),
    );

    expect(metrics.onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(metrics.onRequestSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "test.method",
        durationMs: expect.any(Number),
      }),
    );

    expect(metrics.onRequestError).not.toHaveBeenCalled();

    client.stop();
  }, 5000);

  test("calls onRequestError when request fails", async () => {
    const port = await getFreePort();
    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    setupWss(wss, () => ({ ok: false, error: "not found" }));

    const metrics: GatewayClientMetrics = {
      onRequestStart: vi.fn(),
      onRequestSuccess: vi.fn(),
      onRequestError: vi.fn(),
    };

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      metrics,
    });

    const connected = new Promise<void>((resolve) => {
      client.start();
      const original = client["opts"].onHelloOk;
      client["opts"].onHelloOk = (hello) => {
        original?.(hello);
        resolve();
      };
    });

    await connected;

    try {
      await client.request("failing.method");
    } catch {
      // Expected
    }

    expect(metrics.onRequestStart).toHaveBeenCalledTimes(1);
    expect(metrics.onRequestError).toHaveBeenCalledTimes(1);
    expect(metrics.onRequestError).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "failing.method",
        durationMs: expect.any(Number),
      }),
    );

    client.stop();
  }, 5000);

  test("calls onReconnect during reconnection attempts", async () => {
    const port = await getFreePort();
    // Don't start a WS server — connection will fail and trigger reconnect.

    const metrics: GatewayClientMetrics = {
      onReconnect: vi.fn(),
    };

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      metrics,
    });

    client.start();

    // Wait enough time for at least one reconnect attempt.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(metrics.onReconnect).toHaveBeenCalled();
    const firstCall = (metrics.onReconnect as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      attempt: number;
      delayMs: number;
    };
    expect(firstCall.attempt).toBe(1);
    expect(firstCall.delayMs).toBeGreaterThan(0);

    client.stop();
  }, 5000);

  test("resets reconnect counter after successful connection", async () => {
    const port = await getFreePort();
    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    setupWss(wss);

    const metrics: GatewayClientMetrics = {
      onReconnect: vi.fn(),
    };

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      metrics,
    });

    const connected = new Promise<void>((resolve) => {
      client.start();
      const original = client["opts"].onHelloOk;
      client["opts"].onHelloOk = (hello) => {
        original?.(hello);
        resolve();
      };
    });

    await connected;

    // Access private reconnectAttempt to verify reset.
    expect((client as unknown as { reconnectAttempt: number }).reconnectAttempt).toBe(0);

    client.stop();
  }, 5000);
});
