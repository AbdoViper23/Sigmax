import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { Server } from "../base/server.js";
import { versionToHex } from "../base/types.js";
import { VERSION } from "../app/config.js";
import {
  register,
  reportState,
  setSignPort,
  resetState,
} from "../app/handlers.js";
import { bytesToHex, hexToBytes } from "../base/encoding.js";
import { abiDecodeTwo } from "../app/abi.js";

function stringToBytes32Hex(s: string): string {
  return versionToHex(s);
}

function makeActionBody(
  opType: string,
  opCommand: string,
  originalMessage: string
): string {
  const df = {
    instructionId:
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    teeId: "0x0000000000000000000000000000000001",
    timestamp: 1234567890,
    opType,
    opCommand,
    originalMessage,
  };

  const dfJson = JSON.stringify(df);
  const action = {
    data: {
      id: "0x0000000000000000000000000000000000000000000000000000000000000001",
      type: "instruction",
      submissionTag: "submit",
      message: bytesToHex(new TextEncoder().encode(dfJson)),
    },
  };

  return JSON.stringify(action);
}

function startMockNode(
  responseBytes: Uint8Array,
  shouldFail = false
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/decrypt" && req.method === "POST") {
        if (shouldFail) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "decryption error" }));
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              decryptedMessage: Buffer.from(responseBytes).toString("base64"),
            })
          );
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

describe("handlers integration", () => {
  let mockServer: http.Server | null = null;

  beforeEach(() => {
    resetState();
  });

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
      mockServer = null;
    }
  });

  it("update and sign flow", async () => {
    const privKeyBytes = new Uint8Array(32);
    privKeyBytes[30] = 0x30;
    privKeyBytes[31] = 0x39; // 12345

    const { server, port } = await startMockNode(privKeyBytes);
    mockServer = server;
    setSignPort(String(port));

    const srv = new Server(
      "0",
      String(port),
      VERSION,
      register,
      reportState
    );

    // Step 1: Update key
    const updateBody = makeActionBody(
      stringToBytes32Hex("KEY"),
      stringToBytes32Hex("UPDATE"),
      bytesToHex(new TextEncoder().encode("encrypteddata"))
    );
    const [updateStatus, updateResp] = await srv.handleRequestDirect(
      "POST",
      "/action",
      updateBody
    );
    expect(updateStatus).toBe(200);
    expect((updateResp as any).status).toBe(1);

    // Step 2: Sign
    const msgHex = bytesToHex(new TextEncoder().encode("hello"));
    const signBody = makeActionBody(
      stringToBytes32Hex("KEY"),
      stringToBytes32Hex("SIGN"),
      msgHex
    );
    const [signStatus, signResp] = await srv.handleRequestDirect(
      "POST",
      "/action",
      signBody
    );
    expect(signStatus).toBe(200);
    expect((signResp as any).status).toBe(1);
    expect((signResp as any).data).toBeDefined();

    // Decode ABI
    const dataBytes = hexToBytes((signResp as any).data);
    const [msg, sig] = abiDecodeTwo(dataBytes);
    expect(new TextDecoder().decode(msg)).toBe("hello");
    expect(sig.length).toBe(65);
  });

  it("sign without key returns error", async () => {
    setSignPort("9999");
    const srv = new Server("0", "9999", VERSION, register, reportState);

    const msgHex = bytesToHex(new TextEncoder().encode("hello"));
    const body = makeActionBody(
      stringToBytes32Hex("KEY"),
      stringToBytes32Hex("SIGN"),
      msgHex
    );
    const [status, resp] = await srv.handleRequestDirect(
      "POST",
      "/action",
      body
    );
    expect(status).toBe(200);
    expect((resp as any).status).toBe(0);
    expect((resp as any).log).toContain("no private key");
  });

  it("unknown operation returns 501", async () => {
    setSignPort("9999");
    const srv = new Server("0", "9999", VERSION, register, reportState);

    const body = makeActionBody(
      stringToBytes32Hex("UNKNOWN"),
      stringToBytes32Hex("OP"),
      "0xdeadbeef"
    );
    const [status] = await srv.handleRequestDirect("POST", "/action", body);
    expect(status).toBe(501);
  });

  it("update with empty message returns error", async () => {
    setSignPort("9999");
    const srv = new Server("0", "9999", VERSION, register, reportState);

    const body = makeActionBody(
      stringToBytes32Hex("KEY"),
      stringToBytes32Hex("UPDATE"),
      ""
    );
    const [status, resp] = await srv.handleRequestDirect(
      "POST",
      "/action",
      body
    );
    expect(status).toBe(200);
    expect((resp as any).status).toBe(0);
    expect((resp as any).log).toContain("originalMessage is empty");
  });

  it("GET /action returns 405", async () => {
    const srv = new Server("0", "9999", VERSION, register, reportState);
    const [status] = await srv.handleRequestDirect("GET", "/action", "");
    expect(status).toBe(405);
  });

  it("GET /state returns state", async () => {
    const srv = new Server("0", "9999", VERSION, register, reportState);
    const [status, resp] = await srv.handleRequestDirect(
      "GET",
      "/state",
      ""
    );
    expect(status).toBe(200);
    expect((resp as any).stateVersion).toBeDefined();
    expect((resp as any).state.hasKey).toBe(false);
  });

  it("POST /state returns 405", async () => {
    const srv = new Server("0", "9999", VERSION, register, reportState);
    const [status] = await srv.handleRequestDirect("POST", "/state", "");
    expect(status).toBe(405);
  });

  it("decryption failure returns error", async () => {
    const { server, port } = await startMockNode(new Uint8Array(0), true);
    mockServer = server;
    setSignPort(String(port));

    const srv = new Server(
      "0",
      String(port),
      VERSION,
      register,
      reportState
    );

    const body = makeActionBody(
      stringToBytes32Hex("KEY"),
      stringToBytes32Hex("UPDATE"),
      bytesToHex(new TextEncoder().encode("baddata"))
    );
    const [status, resp] = await srv.handleRequestDirect(
      "POST",
      "/action",
      body
    );
    expect(status).toBe(200);
    expect((resp as any).status).toBe(0);
    expect((resp as any).log).toContain("decryption failed");
  });
});
