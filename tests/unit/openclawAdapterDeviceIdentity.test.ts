// MIT License - Copyright (c) 2026 kiritigowda
// See LICENSE file for details.

/**
 * @vitest-environment node
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildGatewayConnectProfile } from "@/lib/controlplane/gateway-connect-profile";
import {
  loadOrCreateDeviceIdentity,
  signConnectChallenge,
  type DeviceConnectParams,
} from "@/lib/controlplane/device-identity";

const makeTempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

describe("device identity integration", () => {
  const priorStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = makeTempDir("device-identity-integration");
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(() => {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  describe("connect profile with device identity", () => {
    it("builds profile with deviceFamily field", () => {
      const profile = buildGatewayConnectProfile({
        profileId: "backend-local",
        upstreamUrl: "ws://localhost:8080",
        token: "test-token",
        minProtocol: 3,
        maxProtocol: 3,
        capabilities: ["tool-events"],
      });

      expect(profile.connectParams.client.deviceFamily).toBe("rocclaw");
      expect(profile.connectParams.client.id).toBe("gateway-client");
      expect(profile.connectParams.client.mode).toBe("backend");
      expect(profile.connectParams.client.platform).toBe("node");
    });

    it("builds legacy profile with web platform", () => {
      const profile = buildGatewayConnectProfile({
        profileId: "legacy-control-ui",
        upstreamUrl: "ws://localhost:8080",
        token: "test-token",
        minProtocol: 3,
        maxProtocol: 3,
        capabilities: ["tool-events"],
      });

      expect(profile.connectParams.client.deviceFamily).toBe("rocclaw");
      expect(profile.connectParams.client.id).toBe("openclaw-control-ui");
      expect(profile.connectParams.client.mode).toBe("webchat");
      expect(profile.connectParams.client.platform).toBe("web");
    });

    it("includes all operator scopes", () => {
      const profile = buildGatewayConnectProfile({
        profileId: "backend-local",
        upstreamUrl: "ws://localhost:8080",
        token: "test-token",
        minProtocol: 3,
        maxProtocol: 3,
        capabilities: ["tool-events"],
      });

      expect(profile.connectParams.scopes).toContain("operator.admin");
      expect(profile.connectParams.scopes).toContain("operator.read");
      expect(profile.connectParams.scopes).toContain("operator.write");
      expect(profile.connectParams.scopes).toContain("operator.approvals");
      expect(profile.connectParams.scopes).toContain("operator.pairing");
      expect(profile.connectParams.role).toBe("operator");
    });
  });

  describe("device identity signing", () => {
    it("creates device connect params matching profile", () => {
      const identityPath = path.join(tempDir!, "device.json");
      const identity = loadOrCreateDeviceIdentity(identityPath);

      const profile = buildGatewayConnectProfile({
        profileId: "backend-local",
        upstreamUrl: "ws://localhost:8080",
        token: "test-token",
        minProtocol: 3,
        maxProtocol: 3,
        capabilities: ["tool-events"],
      });

      const deviceParams: DeviceConnectParams = signConnectChallenge(identity, {
        nonce: "test-challenge-nonce",
        platform: profile.connectParams.client.platform,
        deviceFamily: profile.connectParams.client.deviceFamily,
        role: profile.connectParams.role,
        scopes: profile.connectParams.scopes,
        client: {
          id: profile.connectParams.client.id,
          version: profile.connectParams.client.version,
          mode: profile.connectParams.client.mode,
        },
        token: profile.connectParams.auth.token,
      });

      // Device params should match expected structure
      expect(deviceParams.id).toBe(identity.deviceId);
      expect(deviceParams.nonce).toBe("test-challenge-nonce");
      expect(deviceParams.publicKey).toBeDefined();
      expect(deviceParams.signature).toBeDefined();
      expect(deviceParams.signedAt).toBeGreaterThan(0);

      // Values should be in expected format
      expect(deviceParams.publicKey).not.toContain("+"); // base64url
      expect(deviceParams.publicKey).not.toContain("/");
      expect(deviceParams.signature).not.toContain("+");
      expect(deviceParams.signature).not.toContain("/");
    });

    it("creates different signatures for different nonces", () => {
      const identityPath = path.join(tempDir!, "device.json");
      const identity = loadOrCreateDeviceIdentity(identityPath);

      const params1 = signConnectChallenge(identity, {
        nonce: "nonce-1",
        platform: "node",
        deviceFamily: "rocclaw",
        role: "operator",
        scopes: ["operator.read"],
        client: { id: "test", version: "1.0", mode: "backend" },
        token: "token-1",
      });

      const params2 = signConnectChallenge(identity, {
        nonce: "nonce-2",
        platform: "node",
        deviceFamily: "rocclaw",
        role: "operator",
        scopes: ["operator.read"],
        client: { id: "test", version: "1.0", mode: "backend" },
        token: "token-1",
      });

      // Same identity, different nonces = different signatures
      expect(params1.signature).not.toBe(params2.signature);
      // But same device ID
      expect(params1.id).toBe(params2.id);
    });

    it("creates consistent deviceId across calls", () => {
      const identityPath = path.join(tempDir!, "device.json");
      const identity = loadOrCreateDeviceIdentity(identityPath);

      const params1 = signConnectChallenge(identity, {
        nonce: "nonce-1",
        platform: "node",
        deviceFamily: "rocclaw",
        role: "operator",
        scopes: ["operator.read"],
        client: { id: "test", version: "1.0", mode: "backend" },
        token: "token-1",
      });

      const params2 = signConnectChallenge(identity, {
        nonce: "nonce-2",
        platform: "node",
        deviceFamily: "rocclaw",
        role: "operator",
        scopes: ["operator.read"],
        client: { id: "test", version: "1.0", mode: "backend" },
        token: "token-2",
      });

      // Same device ID for same identity
      expect(params1.id).toBe(params2.id);
      expect(params1.id).toBe(identity.deviceId);
    });
  });

  describe("end-to-end connect payload", () => {
    it("generates complete connect request structure", () => {
      const identityPath = path.join(tempDir!, "device.json");
      const identity = loadOrCreateDeviceIdentity(identityPath);

      const profile = buildGatewayConnectProfile({
        profileId: "backend-local",
        upstreamUrl: "ws://localhost:8080",
        token: "my-auth-token",
        minProtocol: 3,
        maxProtocol: 3,
        capabilities: ["tool-events"],
      });

      const device = signConnectChallenge(identity, {
        nonce: "gateway-challenge-abc123",
        platform: profile.connectParams.client.platform,
        deviceFamily: profile.connectParams.client.deviceFamily,
        role: profile.connectParams.role,
        scopes: profile.connectParams.scopes,
        client: {
          id: profile.connectParams.client.id,
          version: profile.connectParams.client.version,
          mode: profile.connectParams.client.mode,
        },
        token: profile.connectParams.auth.token,
      });

      // Full connect request structure as would be sent to gateway
      const connectRequest = {
        type: "req",
        id: "1",
        method: "connect",
        params: {
          ...profile.connectParams,
          device,
        },
      };

      // Verify structure matches gateway expectations
      expect(connectRequest.params.minProtocol).toBe(3);
      expect(connectRequest.params.maxProtocol).toBe(3);
      expect(connectRequest.params.client.id).toBe("gateway-client");
      expect(connectRequest.params.role).toBe("operator");
      expect(connectRequest.params.device.id).toBe(identity.deviceId);
      expect(connectRequest.params.device.publicKey).toBeDefined();
      expect(connectRequest.params.device.signature).toBeDefined();
      expect(connectRequest.params.device.nonce).toBe("gateway-challenge-abc123");
    });
  });
});
