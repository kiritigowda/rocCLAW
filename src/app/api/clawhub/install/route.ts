// MIT License - Copyright (c) 2026 kiritigowda
// See LICENSE file for details.

import { type NextRequest, NextResponse } from "next/server";

import { executeRuntimeGatewayRead } from "@/lib/controlplane/runtime-read-route";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const slug = (body.slug ?? "").trim();

    if (!slug) {
      return NextResponse.json({ error: "Missing slug" }, { status: 400 });
    }

    const response = await executeRuntimeGatewayRead("skills.install", { source: "clawhub", slug });
    const data = await response.json();

    if (!data.ok) {
      return NextResponse.json(
        { error: data.error ?? "Gateway skills.install failed" },
        { status: response.status }
      );
    }

    const payload = data.payload ?? {};

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
