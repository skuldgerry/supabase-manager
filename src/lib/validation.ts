import { z } from "zod";

const username = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, "Use letters, numbers, dots, underscores, or hyphens");

const strongPassword = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(256)
  .refine((value) => !/[\r\n]/.test(value), "Line breaks are not allowed")
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), {
    message: "Include at least one letter and one number",
  });

export const setupAdminSchema = z.object({
  email: z.email(),
  displayName: z.string().trim().min(1).max(100),
  password: strongPassword,
  organizationName: z.string().trim().min(2).max(100),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});

export const organizationSchema = z.object({
  name: z.string().trim().min(2).max(100),
});

const port = z.number().int().min(1).max(65535);

export const projectCreationSchema = z.object({
  organizationId: z.uuid(),
  hostId: z.uuid(),
  name: z.string().trim().min(2).max(100),
  supabaseRelease: z.string().trim().min(1).max(100),
  publicUrl: z.url(),
  siteUrl: z.url(),
  ports: z.object({
    api: port,
    databaseSession: port,
    databaseTransaction: port,
  }).refine((ports) => new Set(Object.values(ports)).size === 3, {
    message: "Project ports must be unique",
  }),
  dashboardUsername: username,
  credentialsMode: z.enum(["generated", "custom"]),
  customCredentials: z.object({
    postgresPassword: strongPassword,
    dashboardPassword: strongPassword,
    jwtSecret: z.string().min(32).max(512).refine((value) => !/[\r\n]/.test(value), "Line breaks are not allowed"),
  }).optional(),
}).superRefine((value, context) => {
  if (value.credentialsMode === "custom" && !value.customCredentials) {
    context.addIssue({
      code: "custom",
      path: ["customCredentials"],
      message: "Custom credentials are required when custom mode is selected",
    });
  }
});

/** Inputs needed to safely adopt an already-running self-hosted stack. */
export const projectImportSchema = z.object({
  organizationId: z.uuid(),
  name: z.string().trim().min(2).max(100),
  apiUrl: z.url(),
  siteUrl: z.url().optional(),
  dbHost: z.string().trim().min(1).max(253),
  dbPort: port.default(5432),
  databaseSessionPort: port,
  databaseTransactionPort: port,
  supabaseRelease: z.string().trim().regex(/^self-hosted\/v\d+\.\d+\.\d+$/, "Use an official self-hosted release tag"),
  dashboardUsername: username,
  postgresPassword: strongPassword,
  dashboardPassword: strongPassword,
  jwtSecret: z.string().min(32).max(512).refine((value) => !/[\r\n]/.test(value), "Line breaks are not allowed"),
  anonKey: z.string().trim().min(20).max(4096),
  serviceRoleKey: z.string().trim().min(20).max(4096),
  publishableKey: z.string().trim().min(1).max(4096).optional(),
  secretKey: z.string().trim().min(1).max(4096).optional(),
}).superRefine((value, context) => {
  if (value.databaseSessionPort === value.databaseTransactionPort) {
    context.addIssue({ code: "custom", path: ["databaseSessionPort"], message: "Session and transaction pooler ports must differ" });
  }
});

export type SetupAdminInput = z.infer<typeof setupAdminSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateOrganizationInput = z.infer<typeof organizationSchema>;
export type CreateProjectInput = z.infer<typeof projectCreationSchema>;
export type ImportProjectInput = z.infer<typeof projectImportSchema>;
