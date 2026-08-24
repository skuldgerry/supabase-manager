import path from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MANAGER_DATA_DIR: z.string().min(1).optional(),
  MANAGER_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MANAGER_BIND_ADDRESS: z.string().min(1).default("0.0.0.0"),
  MANAGER_PUBLIC_URL: z.url().default("http://localhost:3000"),
  MANAGER_MASTER_KEY: z.string().optional(),
  DOCKER_SOCKET_PATH: z.string().min(1).default("/var/run/docker.sock"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),
});

export type ManagerConfig = {
  nodeEnv: "development" | "test" | "production";
  dataDir: string;
  databasePath: string;
  releaseCacheDir: string;
  port: number;
  bindAddress: string;
  publicUrl: string;
  masterKey?: string;
  dockerSocketPath: string;
  sessionTtlHours: number;
};

let cachedConfig: ManagerConfig | undefined;

export function getConfig(): ManagerConfig {
  if (cachedConfig) return cachedConfig;

  const env = environmentSchema.parse(process.env);
  const dataDir = path.resolve(
    env.MANAGER_DATA_DIR ?? (env.NODE_ENV === "production" ? "/data" : "./data"),
  );

  cachedConfig = {
    nodeEnv: env.NODE_ENV,
    dataDir,
    databasePath: path.join(dataDir, "manager.sqlite"),
    releaseCacheDir: path.join(dataDir, "releases"),
    port: env.MANAGER_PORT,
    bindAddress: env.MANAGER_BIND_ADDRESS,
    publicUrl: env.MANAGER_PUBLIC_URL,
    masterKey: env.MANAGER_MASTER_KEY || undefined,
    dockerSocketPath: env.DOCKER_SOCKET_PATH,
    sessionTtlHours: env.SESSION_TTL_HOURS,
  };

  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}
