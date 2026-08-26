import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/config";

function internalToken(): string {
  const config = getConfig();
  const value = config.internalToken ?? readFileSync(config.internalTokenFile, "utf8").trim();
  if (value.length < 32) throw new Error("manager internal token is not configured");
  return value;
}

function equalSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authorizeInternalRequest(request: Request): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  try {
    return equalSecret(match[1], internalToken());
  } catch {
    return false;
  }
}

export function unauthorizedInternalResponse(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
