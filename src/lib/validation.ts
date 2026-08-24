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

export type SetupAdminInput = z.infer<typeof setupAdminSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateOrganizationInput = z.infer<typeof organizationSchema>;
export type CreateProjectInput = z.infer<typeof projectCreationSchema>;
