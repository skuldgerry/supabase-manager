import assert from "node:assert/strict";
import test from "node:test";
import { closeDatabase, openDatabase } from "../../src/lib/db";
import { ControlPlaneRepository } from "../../src/lib/db/repository";
import type { UserId } from "../../src/lib/domain";

function fixture() {
  const db = openDatabase();
  const repository = new ControlPlaneRepository(db);
  const admin = repository.createFirstAdmin({ email: "Admin@Example.com", displayName: "Admin", passwordHash: "argon2-hash" });
  return { db, repository, admin };
}

test("first-admin creation is one-time and setup survives lookup", () => {
  const { db, repository, admin } = fixture();
  assert.equal(repository.isSetupComplete(), true);
  assert.equal(repository.getUserByEmail("admin@example.com")?.id, admin.id);
  assert.throws(() => repository.createFirstAdmin({ email: "second@example.com", displayName: "Second", passwordHash: "hash" }), /already complete/);
  closeDatabase(db);
});

test("initial bootstrap creates the admin, default organization, and owner membership atomically", () => {
  const db = openDatabase();
  const repository = new ControlPlaneRepository(db);
  const bootstrapped = repository.bootstrapControlPlane({
    email: "Owner@Example.com",
    displayName: "Owner",
    passwordHash: "argon2-hash",
    organizationName: "Default Organization",
    organizationSlug: "default-organization",
  });

  assert.equal(repository.isSetupComplete(), true);
  assert.equal(repository.getUserByEmail("owner@example.com")?.id, bootstrapped.user.id);
  assert.deepEqual(repository.listOrganizations(bootstrapped.user.id).map((org) => org.id), [bootstrapped.organization.id]);
  assert.equal(bootstrapped.ownerMembership.userId, bootstrapped.user.id);
  assert.equal(bootstrapped.ownerMembership.organizationId, bootstrapped.organization.id);
  assert.equal(bootstrapped.ownerMembership.role, "owner");
  assert.throws(() => repository.bootstrapControlPlane({
    email: "second@example.com",
    displayName: "Second",
    passwordHash: "hash",
    organizationName: "Another",
    organizationSlug: "another",
  }), /already complete/);
  closeDatabase(db);
});

test("initial bootstrap rolls back the admin when organization creation fails", () => {
  const db = openDatabase();
  const repository = new ControlPlaneRepository(db);
  assert.throws(() => repository.bootstrapControlPlane({
    email: "owner@example.com",
    displayName: "Owner",
    passwordHash: "argon2-hash",
    organizationName: " ",
    organizationSlug: "default-organization",
  }), /organizationName is required/);
  assert.equal(repository.isSetupComplete(), false);
  assert.equal(repository.getUserByEmail("owner@example.com"), null);
  closeDatabase(db);
});

test("sessions can be looked up by hash and revoked", () => {
  const { db, repository, admin } = fixture();
  const session = repository.createSession({ userId: admin.id, tokenHash: "token-hash", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(repository.getSessionByTokenHash("token-hash")?.id, session.id);
  assert.equal(repository.revokeSession(session.id), true);
  assert.equal(repository.getSessionByTokenHash("token-hash"), null);
  closeDatabase(db);
});

test("organization creation atomically creates owner membership and projects/jobs/events", () => {
  const { db, repository, admin } = fixture();
  const host = repository.bootstrapLocalHost();
  const created = repository.createOrganization({ name: "Acme", slug: "acme", createdBy: admin.id });
  assert.equal(created.ownerMembership.role, "owner");
  const project = repository.createProject({ organizationId: created.organization.id, hostId: host.id, name: "Main", slug: "main", stackRelease: "v1", ports: { api: 8100, dbSession: 54100, dbTransaction: 55100 }, databaseUsername: "app", dashboardUsername: "studio", createdBy: admin.id });
  const job = repository.createJob({ type: "create-project", projectId: project.id, requestedBy: admin.id });
  const event = repository.appendJobEvent({ jobId: job.id, level: "info", message: "Validated", details: { stageNumber: 1 } });
  repository.upsertCredential({ projectId: project.id, kind: "other", name: "project-credentials", ciphertextBase64: "ciphertext", nonceBase64: "nonce", authTagBase64: "tag", associatedData: `${project.id}:project-credentials` });
  assert.equal(repository.listProjects(created.organization.id)[0]?.id, project.id);
  assert.equal(repository.listJobEvents(job.id)[0]?.id, event.id);
  assert.equal(repository.getCredential(project.id, "project-credentials")?.associatedData, `${project.id}:project-credentials`);
  closeDatabase(db);
});

test("organization transfer atomically changes ownership without changing project identity", () => {
  const { db, repository, admin } = fixture();
  const host = repository.bootstrapLocalHost();
  const source = repository.createOrganization({ name: "Source", slug: "source", createdBy: admin.id });
  const destination = repository.createOrganization({ name: "Destination", slug: "destination", createdBy: admin.id });
  const project = repository.createProject({ organizationId: source.organization.id, hostId: host.id, name: "Main", slug: "main", stackRelease: "v1", ports: { api: 8101, dbSession: 54101, dbTransaction: 55101 }, databaseUsername: "app", dashboardUsername: "studio", createdBy: admin.id });
  const transfer = repository.transferProject({ projectId: project.id, toOrganizationId: destination.organization.id, requestedBy: admin.id, destinationApprovedBy: admin.id });
  assert.equal(transfer.status, "completed");
  assert.equal(repository.getProject(project.id)?.organizationId, destination.organization.id);
  assert.equal(repository.getProject(project.id)?.hostId, host.id);
  assert.equal(repository.getProject(project.id)?.id, project.id);
  closeDatabase(db);
});

test("organization transfer rejects a user without manager permission", () => {
  const { db, repository, admin } = fixture();
  const host = repository.bootstrapLocalHost();
  const source = repository.createOrganization({ name: "Source", slug: "source", createdBy: admin.id });
  const destination = repository.createOrganization({ name: "Destination", slug: "destination", createdBy: admin.id });
  const project = repository.createProject({ organizationId: source.organization.id, hostId: host.id, name: "Main", slug: "main", stackRelease: "v1", ports: { api: 8102, dbSession: 54102, dbTransaction: 55102 }, databaseUsername: "app", dashboardUsername: "studio", createdBy: admin.id });
  assert.throws(() => repository.transferProject({ projectId: project.id, toOrganizationId: destination.organization.id, requestedBy: "not-a-member" as UserId, destinationApprovedBy: admin.id }), /permission required/);
  closeDatabase(db);
});

test("project deployment atomically reserves ports and creates a durable job", () => {
  const { db, repository, admin } = fixture();
  const host = repository.bootstrapLocalHost();
  const organization = repository.createOrganization({ name: "Acme", slug: "acme", createdBy: admin.id }).organization;
  const first = repository.createProjectDeployment({ organizationId: organization.id, hostId: host.id, name: "One", slug: "one", stackRelease: "self-hosted/v0.8.0", ports: { api: 8200, dbSession: 54200, dbTransaction: 55200 }, databaseUsername: "postgres", dashboardUsername: "admin", createdBy: admin.id });
  assert.equal(first.job.projectId, first.project.id);
  assert.throws(() => repository.createProjectDeployment({ organizationId: organization.id, hostId: host.id, name: "Two", slug: "two", stackRelease: "self-hosted/v0.8.0", ports: { api: 8200, dbSession: 54201, dbTransaction: 55201 }, databaseUsername: "postgres", dashboardUsername: "admin", createdBy: admin.id }), /UNIQUE constraint failed/);
  repository.activateProjectPorts(first.project.id);
  repository.updateProjectStatus(first.project.id, "ready");
  assert.equal(repository.getProject(first.project.id)?.status, "ready");
  closeDatabase(db);
});

test("project deletion requires manager permission and tombstones the project", () => {
  const { db, repository, admin } = fixture();
  const host = repository.bootstrapLocalHost();
  const organization = repository.createOrganization({ name: "Acme", slug: "acme", createdBy: admin.id }).organization;
  const project = repository.createProject({ organizationId: organization.id, hostId: host.id, name: "Disposable", slug: "disposable", stackRelease: "self-hosted/v0.8.0", ports: { api: 8300, dbSession: 54300, dbTransaction: 55300 }, databaseUsername: "postgres", dashboardUsername: "admin", createdBy: admin.id });
  assert.throws(() => repository.queueProjectDeletion(project.id, "not-a-member" as UserId), /permission required/);
  const job = repository.queueProjectDeletion(project.id, admin.id);
  assert.equal(job.type, "delete-project");
  assert.equal(repository.getProject(project.id)?.status, "deleting");
  repository.markProjectDeleted(project.id);
  assert.equal(repository.listProjects(organization.id).length, 0);
  closeDatabase(db);
});

test("external project adoption records ownership without reserving manager ports", () => {
  const { db, repository, admin } = fixture();
  const host = repository.bootstrapLocalHost();
  const organization = repository.createOrganization({ name: "External", slug: "external", createdBy: admin.id }).organization;
  const project = repository.adoptExternalProject({
    organizationId: organization.id,
    hostId: host.id,
    name: "Existing stack",
    slug: "existing-stack",
    stackRelease: "self-hosted/v0.8.0",
    publicUrl: "https://supabase.example.com",
    siteUrl: "https://app.example.com",
    ports: { api: 8100, dbSession: 54100, dbTransaction: 55100 },
    databaseUsername: "postgres",
    dashboardUsername: "supabase",
    createdBy: admin.id,
    ownership: "external",
  });
  assert.equal(project.ownership, "external");
  assert.equal(project.status, "ready");
  assert.deepEqual(repository.listReservedPorts(host.id), []);
  const job = repository.queueProjectDeletion(project.id, admin.id);
  assert.equal(job.type, "delete-project");
  assert.equal(repository.getProject(project.id)?.ownership, "external");
  closeDatabase(db);
});
