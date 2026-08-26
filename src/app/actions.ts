"use server";

import { redirect } from "next/navigation";
import { createSessionForUser, getAuthenticatedSession, revokeCurrentSession } from "@/lib/auth/session";
import { getRepository } from "@/lib/db/manager";
import type { HostId, OrganizationId, ProjectId } from "@/lib/domain";
import { hashPassword, verifyPassword } from "@/lib/security/password";
import { decryptJson, encryptJson, getMasterKey, type EncryptedEnvelope } from "@/lib/security/encryption";
import { scheduleProvisioning } from "@/lib/orchestrator/broker";
import { adapterForRelease, discoverProjectPorts } from "@/lib/orchestrator";
import { loginSchema, organizationSchema, projectCreationSchema, projectImportSchema, setupAdminSchema } from "@/lib/validation";
import { validateExternalAdoption } from "@/lib/orchestrator/external-adoption";

export type FormActionState = { error?: string };
export type RevealedProjectCredentials = {
  url: string;
  publishable: string;
  secret: string;
  database: string;
  jwt: string;
  dashboard: string;
};
export type RevealCredentialsResult = { credentials?: RevealedProjectCredentials; error?: string };

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "project";
}

export async function setupAdminAction(
  _state: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const repository = getRepository();
  if (repository.isSetupComplete()) return { error: "Initial setup has already been completed." };
  if (formString(formData, "password") !== formString(formData, "confirmPassword")) {
    return { error: "The passwords do not match." };
  }

  const parsed = setupAdminSchema.safeParse({
    email: formString(formData, "email"),
    displayName: formString(formData, "displayName"),
    password: formString(formData, "password"),
    organizationName: formString(formData, "organizationName") || "Default Organization",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid administrator details." };

  try {
    const { user } = repository.bootstrapControlPlane({
      email: parsed.data.email,
      displayName: parsed.data.displayName,
      passwordHash: await hashPassword(parsed.data.password),
      organizationName: parsed.data.organizationName,
      organizationSlug: slugify(parsed.data.organizationName),
    });
    await createSessionForUser(user);
  } catch {
    return { error: "The administrator account could not be created." };
  }
  redirect("/");
}

export async function loginAction(
  _state: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const parsed = loginSchema.safeParse({
    email: formString(formData, "email"),
    password: formString(formData, "password"),
  });
  if (!parsed.success) return { error: "Enter a valid email address and password." };

  const user = getRepository().getUserByEmail(parsed.data.email);
  if (!user || user.status !== "active" || !(await verifyPassword(user.passwordHash, parsed.data.password))) {
    return { error: "The email address or password is incorrect." };
  }
  await createSessionForUser(user);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await revokeCurrentSession();
  redirect("/");
}

export async function createOrganizationAction(formData: FormData): Promise<void> {
  const authenticated = await getAuthenticatedSession();
  if (!authenticated) redirect("/");

  const parsed = organizationSchema.safeParse({ name: formString(formData, "name") });
  if (!parsed.success) redirect("/?error=invalid-organization");
  try {
    getRepository().createOrganization({
      name: parsed.data.name,
      slug: slugify(parsed.data.name),
      createdBy: authenticated.user.id,
    });
  } catch {
    redirect("/?error=organization-exists");
  }
  redirect("/");
}

export async function createProjectAction(
  _state: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const authenticated = await getAuthenticatedSession();
  if (!authenticated) return { error: "Your session has expired. Sign in again." };

  const repository = getRepository();
  const host = repository.listHosts()[0];
  if (!host) return { error: "No Docker host is registered." };

  const credentialsMode = formString(formData, "credentialsMode") === "custom" ? "custom" : "generated";
  const customCredentials = credentialsMode === "custom" ? {
    postgresPassword: formString(formData, "postgresPassword"),
    dashboardPassword: formString(formData, "dashboardPassword"),
    jwtSecret: formString(formData, "jwtSecret"),
  } : undefined;
  const parsed = projectCreationSchema.safeParse({
    organizationId: formString(formData, "organizationId"),
    hostId: host.id,
    name: formString(formData, "name"),
    supabaseRelease: formString(formData, "supabaseRelease") || "self-hosted/v0.8.0",
    publicUrl: formString(formData, "publicUrl"),
    siteUrl: formString(formData, "siteUrl"),
    ports: {
      api: Number(formString(formData, "apiPort")),
      databaseSession: Number(formString(formData, "databaseSessionPort")),
      databaseTransaction: Number(formString(formData, "databaseTransactionPort")),
    },
    dashboardUsername: formString(formData, "dashboardUsername"),
    credentialsMode,
    customCredentials,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid project configuration." };

  try {
    adapterForRelease(parsed.data.supabaseRelease);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unsupported official Supabase release." };
  }

  const requestedPorts = {
    api: parsed.data.ports.api,
    dbSession: parsed.data.ports.databaseSession,
    dbTransaction: parsed.data.ports.databaseTransaction,
  };
  const livePorts = await discoverProjectPorts(host.id, requestedPorts);
  if (livePorts.conflicts.length > 0) {
    const summary = livePorts.conflicts.map(({ field, port }) => `${field} (${port})`).join(", ");
    return { error: `These host ports are already in use: ${summary}. Go back to Ports & access to refresh them.` };
  }

  let jobId: string;
  try {
    const deployment = repository.createProjectDeployment({
      organizationId: parsed.data.organizationId as OrganizationId,
      hostId: parsed.data.hostId as HostId,
      name: parsed.data.name,
      slug: slugify(parsed.data.name),
      stackRelease: parsed.data.supabaseRelease,
      publicUrl: parsed.data.publicUrl,
      siteUrl: parsed.data.siteUrl,
      ports: requestedPorts,
      databaseUsername: "postgres",
      dashboardUsername: parsed.data.dashboardUsername,
      createdBy: authenticated.user.id,
    });
    if (parsed.data.customCredentials) {
      const associatedData = `${deployment.project.id}:provisioning-input`;
      const envelope = encryptJson(parsed.data.customCredentials, await getMasterKey(), associatedData);
      repository.upsertCredential({
        projectId: deployment.project.id,
        kind: "other",
        name: "provisioning-input",
        ciphertextBase64: envelope.ciphertext,
        nonceBase64: envelope.iv,
        authTagBase64: envelope.tag,
        associatedData,
      });
    }
    jobId = deployment.job.id;
    scheduleProvisioning(deployment.job.id);
  } catch (error) {
    if (error instanceof Error && /port_reservations|UNIQUE constraint/.test(error.message)) {
      return { error: "One or more selected ports are already reserved." };
    }
    return { error: "The project could not be queued for deployment." };
  }
  redirect(`/?job=${jobId}`);
}

/** Register an existing stack as external; this action never provisions Docker resources. */
export async function importProjectAction(
  _state: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const authenticated = await getAuthenticatedSession();
  if (!authenticated) return { error: "Your session has expired. Sign in again." };
  const parsed = projectImportSchema.safeParse({
    organizationId: formString(formData, "organizationId"),
    name: formString(formData, "name"),
    apiUrl: formString(formData, "apiUrl"),
    siteUrl: formString(formData, "siteUrl") || undefined,
    dbHost: formString(formData, "dbHost"),
    dbPort: Number(formString(formData, "dbPort") || 5432),
    databaseSessionPort: Number(formString(formData, "databaseSessionPort")),
    databaseTransactionPort: Number(formString(formData, "databaseTransactionPort")),
    supabaseRelease: formString(formData, "supabaseRelease") || "self-hosted/v0.8.0",
    dashboardUsername: formString(formData, "dashboardUsername"),
    postgresPassword: formString(formData, "postgresPassword"),
    dashboardPassword: formString(formData, "dashboardPassword"),
    jwtSecret: formString(formData, "jwtSecret"),
    anonKey: formString(formData, "anonKey"),
    serviceRoleKey: formString(formData, "serviceRoleKey"),
    publishableKey: formString(formData, "publishableKey") || undefined,
    secretKey: formString(formData, "secretKey") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid import details." };
  try {
    validateExternalAdoption({
      apiUrl: parsed.data.apiUrl,
      dbHost: parsed.data.dbHost,
      dbPort: parsed.data.dbPort,
      anonKey: parsed.data.anonKey,
      serviceRoleKey: parsed.data.serviceRoleKey,
      postgresPassword: parsed.data.postgresPassword,
      dashboardPassword: parsed.data.dashboardPassword,
      jwtSecret: parsed.data.jwtSecret,
      release: parsed.data.supabaseRelease,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The external project could not be validated." };
  }
  const repository = getRepository();
  const host = repository.listHosts()[0];
  if (!host) return { error: "No manager host is registered." };
  const projectSlug = slugify(parsed.data.name);
  try {
    const project = repository.adoptExternalProject({
      organizationId: parsed.data.organizationId as OrganizationId,
      hostId: host.id,
      name: parsed.data.name,
      slug: projectSlug,
      stackRelease: parsed.data.supabaseRelease,
      publicUrl: parsed.data.apiUrl,
      siteUrl: parsed.data.siteUrl ?? parsed.data.apiUrl,
      ports: { api: (() => { const url = new URL(parsed.data.apiUrl); return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80; })(), dbSession: parsed.data.databaseSessionPort, dbTransaction: parsed.data.databaseTransactionPort },
      databaseUsername: "postgres",
      dashboardUsername: parsed.data.dashboardUsername,
      createdBy: authenticated.user.id,
      ownership: "external",
    });
    const associatedData = `${project.id}:project-credentials`;
    const values = {
      POSTGRES_PASSWORD: parsed.data.postgresPassword,
      JWT_SECRET: parsed.data.jwtSecret,
      ANON_KEY: parsed.data.anonKey,
      SERVICE_ROLE_KEY: parsed.data.serviceRoleKey,
      SUPABASE_PUBLISHABLE_KEY: parsed.data.publishableKey ?? parsed.data.anonKey,
      SUPABASE_SECRET_KEY: parsed.data.secretKey ?? parsed.data.serviceRoleKey,
      DASHBOARD_USERNAME: parsed.data.dashboardUsername,
      DASHBOARD_PASSWORD: parsed.data.dashboardPassword,
      DB_HOST: parsed.data.dbHost,
      DB_PORT: String(parsed.data.dbPort),
      DB_SESSION_PORT: String(parsed.data.databaseSessionPort),
      DB_TRANSACTION_PORT: String(parsed.data.databaseTransactionPort),
    };
    const envelope = encryptJson(values, await getMasterKey(), associatedData);
    repository.upsertCredential({ projectId: project.id, kind: "other", name: "project-credentials", ciphertextBase64: envelope.ciphertext, nonceBase64: envelope.iv, authTagBase64: envelope.tag, associatedData });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The external project could not be registered." };
  }
  redirect("/");
}

export async function revealProjectCredentialsAction(projectIdValue: string): Promise<RevealCredentialsResult> {
  const authenticated = await getAuthenticatedSession();
  if (!authenticated) return { error: "Your session has expired. Sign in again." };
  const repository = getRepository();
  const projectId = projectIdValue as ProjectId;
  const project = repository.getProject(projectId);
  if (!project) return { error: "Project not found." };
  const permitted = repository.canManageOrganization(project.organizationId, authenticated.user.id);
  if (!permitted) return { error: "You do not have access to this project." };
  const stored = repository.getCredential(projectId, "project-credentials");
  if (!stored) return { error: "Credentials are not available until provisioning has generated them." };
  try {
    const envelope: EncryptedEnvelope = {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: stored.nonceBase64,
      tag: stored.authTagBase64,
      ciphertext: stored.ciphertextBase64,
    };
    const values = decryptJson<Record<string, string>>(envelope, await getMasterKey(), stored.associatedData);
    const hostname = values.DB_HOST || new URL(project.publicUrl).hostname;
    const databasePort = values.DB_PORT || String(project.ports.dbSession);
    return { credentials: {
      url: project.publicUrl,
      publishable: values.SUPABASE_PUBLISHABLE_KEY,
      secret: values.SUPABASE_SECRET_KEY,
      database: `postgresql://${encodeURIComponent(values.DB_USER || "postgres")}:${encodeURIComponent(values.POSTGRES_PASSWORD)}@${hostname}:${databasePort}/postgres`,
      jwt: values.JWT_SECRET,
      dashboard: `${project.dashboardUsername}:${values.DASHBOARD_PASSWORD}`,
    } };
  } catch {
    return { error: "The encrypted credential bundle could not be opened." };
  }
}
