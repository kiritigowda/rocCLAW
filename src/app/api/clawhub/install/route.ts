// MIT License - Copyright (c) 2026 kiritigowda
// See LICENSE file for details.

import { type NextRequest, NextResponse } from "next/server";

import { ControlPlaneGatewayError } from "@/lib/controlplane/openclaw-adapter";
import { serializeRuntimeInitFailure } from "@/lib/controlplane/runtime-init-errors";
import { bootstrapDomainRuntime } from "@/lib/controlplane/runtime-route-bootstrap";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const slug = (body.slug ?? "").trim();

    if (!slug) {
      return NextResponse.json({ error: "Missing slug" }, { status: 400 });
    }

    const bootstrap = await bootstrapDomainRuntime();
    if (bootstrap.kind === "mode-disabled") {
      return NextResponse.json({ error: "domain_api_mode_disabled" }, { status: 404 });
    }
    if (bootstrap.kind === "runtime-init-failed") {
      return NextResponse.json(
        { error: serializeRuntimeInitFailure(bootstrap.failure).error ?? "runtime_init_failed" },
        { status: 503 }
      );
    }
    if (bootstrap.kind === "start-failed") {
      return NextResponse.json(
        { error: bootstrap.message, code: "GATEWAY_UNAVAILABLE" },
        { status: 503 }
      );
    }

    let payload: Record<string, unknown>;
    try {
      payload = await bootstrap.runtime.callGateway<Record<string, unknown>>(
        "skills.install",
        { source: "clawhub", slug },
        { timeoutMs: 60_000 }
      );
    } catch (error) {
      if (error instanceof ControlPlaneGatewayError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 502 });
      }
      throw error;
    }

    return NextResponse.json({
      success: true,
      alreadyInstalled: !!payload.alreadyInstalled,
      slug,
      output: payload.output ?? "",
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to install skill";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
