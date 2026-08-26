import { z } from "zod";
import { authorizeInternalRequest, unauthorizedInternalResponse } from "@/lib/internal/auth";
import { getRepository } from "@/lib/db/manager";
import { hashPassword } from "@/lib/security/password";
import { setupAdminSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!authorizeInternalRequest(request)) return unauthorizedInternalResponse();

  const parsed = setupAdminSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }

  const repository = getRepository();
  if (repository.isSetupComplete()) {
    const user = repository.getUserByEmail(parsed.data.email);
    const organization = user
      ? repository.listOrganizations(user.id).find((item) => item.name === parsed.data.organizationName)
      : undefined;
    if (user && organization) {
      return Response.json({ user: { id: user.id, email: user.email }, organization, existing: true });
    }
    return Response.json({ error: "The broker has already been initialized by another administrator." }, { status: 409 });
  }

  const slug = parsed.data.organizationName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "default-organization";
  const result = repository.bootstrapControlPlane({
    email: parsed.data.email,
    displayName: parsed.data.displayName,
    passwordHash: await hashPassword(parsed.data.password),
    organizationName: parsed.data.organizationName,
    organizationSlug: slug,
  });
  return Response.json({
    user: { id: result.user.id, email: result.user.email },
    organization: result.organization,
    existing: false,
  }, { status: 201 });
}
