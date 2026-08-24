import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { getRepository } from "@/lib/db/manager";
import type { Session, User } from "@/lib/domain";
import { createOpaqueToken, hashToken } from "@/lib/security/tokens";

export const SESSION_COOKIE = "supabase_manager_session";

export async function createSessionForUser(user: User): Promise<void> {
  const config = getConfig();
  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000);
  getRepository().createSession({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: expiresAt.toISOString(),
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.publicUrl.startsWith("https://"),
    path: "/",
    expires: expiresAt,
  });
}

export async function getAuthenticatedSession(): Promise<{ session: Session; user: User } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const repository = getRepository();
  const session = repository.getSessionByTokenHash(hashToken(token));
  if (!session) return null;
  const user = repository.getUserById(session.userId);
  if (!user || user.status !== "active") return null;
  return { session, user };
}

export async function revokeCurrentSession(): Promise<void> {
  const authenticated = await getAuthenticatedSession();
  if (authenticated) getRepository().revokeSession(authenticated.session.id);
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}
