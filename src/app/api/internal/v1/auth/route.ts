import { z } from "zod";
import { getRepository } from "@/lib/db/manager";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { beginMfaEnrollment, consumeRecoveryCode, disableMfa, enableMfa, getMfaFactor } from "@/lib/security/mfa-store";
import { verifyPassword } from "@/lib/security/password";
import { generateTotpSecret, recoveryCodes, verifyTotp } from "@/lib/security/totp";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("login"), email: z.email(), password: z.string().min(1), code: z.string().trim().optional() }),
  z.object({ action: z.literal("enroll"), email: z.email(), password: z.string().min(1) }),
  z.object({ action: z.literal("confirm"), email: z.email(), password: z.string().min(1), code: z.string().trim().min(6).max(32) }),
  z.object({ action: z.literal("disable"), email: z.email(), password: z.string().min(1), code: z.string().trim().min(6).max(32) }),
]);

async function authenticatedUser(email: string, password: string) {
  const user = getRepository().getUserByEmail(email);
  if (!user || user.status !== "active" || !(await verifyPassword(user.passwordHash, password))) return null;
  return user;
}

export async function GET(request: Request) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const email = new URL(request.url).searchParams.get("email") ?? "";
  const user = getRepository().getUserByEmail(email);
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });
  const factor = await getMfaFactor(user.id);
  return Response.json({ enabled: Boolean(factor?.enabled), enrollmentPending: Boolean(factor && !factor.enabled) }, { headers: { "Cache-Control": "no-store, private" } });
}

export async function POST(request: Request) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid authentication request" }, { status: 400 });
  const user = await authenticatedUser(parsed.data.email, parsed.data.password);
  if (!user) return Response.json({ error: "Invalid credentials" }, { status: 401 });

  const factor = await getMfaFactor(user.id);
  if (parsed.data.action === "login") {
    if (!factor?.enabled) return Response.json({ ok: true, user: { id: user.id, email: user.email } });
    if (!parsed.data.code) return Response.json({ ok: false, mfaRequired: true }, { status: 202 });
    const valid = verifyTotp(factor.secret, parsed.data.code) || consumeRecoveryCode(user.id, parsed.data.code);
    if (!valid) return Response.json({ error: "Invalid authenticator or recovery code", mfaRequired: true }, { status: 401 });
    return Response.json({ ok: true, user: { id: user.id, email: user.email } });
  }

  if (parsed.data.action === "enroll") {
    const secret = generateTotpSecret();
    await beginMfaEnrollment(user.id, secret);
    const label = encodeURIComponent(user.email);
    const issuer = encodeURIComponent("Supabase Manager");
    return Response.json({ enabled: false, secret, otpauthUri: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` });
  }

  if (!factor) return Response.json({ error: "Authenticator enrollment has not started" }, { status: 409 });
  const valid = verifyTotp(factor.secret, parsed.data.code) || (factor.enabled && consumeRecoveryCode(user.id, parsed.data.code));
  if (!valid) return Response.json({ error: "Invalid authenticator or recovery code" }, { status: 401 });

  if (parsed.data.action === "confirm") {
    const codes = recoveryCodes();
    enableMfa(user.id, codes);
    return Response.json({ enabled: true, recoveryCodes: codes });
  }

  disableMfa(user.id);
  return Response.json({ enabled: false });
}
