import { describe, expect, test, vi } from "vitest";
import { NodeRegistry } from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function makeFakeClient(overrides?: Partial<{ nodeId: string; connId: string }>): GatewayWsClient {
  const connId = overrides?.connId ?? "conn-1";
  const nodeId = overrides?.nodeId ?? "node-1";
  return {
    connId,
    socket: {
      send: vi.fn(),
    } as unknown as GatewayWsClient["socket"],
    connect: {
      minProtocol: 2,
      maxProtocol: 2,
      client: {
        id: nodeId,
        version: "dev",
        platform: "test",
        mode: "node",
      },
      caps: [],
      role: "operator",
      scopes: ["operator.admin"],
      device: { id: nodeId, publicKey: "", signature: "", signedAt: 0 },
    } as unknown as GatewayWsClient["connect"],
  };
}

describe("NodeRegistry", () => {
  test("returns QUEUE_FULL when pending invoke limit is exceeded", async () => {
    const registry = new NodeRegistry();
    const client = makeFakeClient();
    registry.register(client, {});

    // Fill pendingInvokes to the limit (1000) by invoking without ever resolving.
    // Attach .catch() so unregister rejections don't become unhandled.
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i++) {
      promises.push(
        registry.invoke({
          nodeId: "node-1",
          command: "test.cmd",
          timeoutMs: 60_000,
        }).catch(() => {}),
      );
    }

    // The next invoke should fail immediately with QUEUE_FULL.
    const result = await registry.invoke({
      nodeId: "node-1",
      command: "test.cmd",
      timeoutMs: 60_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("QUEUE_FULL");
    expect(result.error?.message).toMatch(/pending invoke limit exceeded/);

    // Cleanup: unregister to cancel pending timers and reject pending invokes.
    registry.unregister(client.connId);
    await Promise.all(promises);
  }, 15000);
});
