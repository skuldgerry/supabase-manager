import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "@/lib/config";
import { openDatabase, type SqliteDatabase } from "./index";
import { ControlPlaneRepository } from "./repository";

type DatabaseSingleton = {
  database: SqliteDatabase;
  repository: ControlPlaneRepository;
};

const globalDatabase = globalThis as typeof globalThis & {
  __supabaseManagerDatabase?: DatabaseSingleton;
};

export function getDatabaseContext(): DatabaseSingleton {
  if (globalDatabase.__supabaseManagerDatabase) return globalDatabase.__supabaseManagerDatabase;

  const config = getConfig();
  mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  const database = openDatabase(config.databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  const repository = new ControlPlaneRepository(database);
  repository.bootstrapLocalHost({ dockerSocketPath: config.dockerSocketPath });

  globalDatabase.__supabaseManagerDatabase = { database, repository };
  return globalDatabase.__supabaseManagerDatabase;
}

export function getRepository(): ControlPlaneRepository {
  return getDatabaseContext().repository;
}
