import type { ProjectPorts } from "./types";

export const PORT_KINDS = ["api", "dbSession", "dbTransaction"] as const;
export type PortKind = (typeof PORT_KINDS)[number];

export class PortValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortValidationError";
  }
}

export function validatePort(port: number, field = "port"): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PortValidationError(`${field} must be an integer between 1 and 65535`);
  }
  return port;
}

export function validateProjectPorts(ports: ProjectPorts): ProjectPorts {
  const result = {
    api: validatePort(ports.api, "api"),
    dbSession: validatePort(ports.dbSession, "dbSession"),
    dbTransaction: validatePort(ports.dbTransaction, "dbTransaction"),
  };
  const values = Object.values(result);
  if (new Set(values).size !== values.length) throw new PortValidationError("project ports must be unique");
  return result;
}

export interface PortAvailabilityChecker {
  isAvailable(port: number): Promise<boolean>;
}

export interface PortReservation {
  readonly token: string;
  readonly ports: ReadonlySet<number>;
  release(): Promise<void>;
  commit(): Promise<void>;
}

/** Atomic in-process reservations; persist the same decision in the DB at the application boundary. */
export class PortReservationRegistry {
  private readonly reserved = new Map<number, string>();
  private sequence = 0;

  constructor(private readonly checker?: PortAvailabilityChecker) {}

  async reserve(ports: ProjectPorts): Promise<PortReservation> {
    const checked = validateProjectPorts(ports);
    const values = new Set(Object.values(checked));
    for (const port of values) {
      if (this.reserved.has(port)) throw new PortValidationError(`port ${port} is already reserved`);
      if (this.checker && !(await this.checker.isAvailable(port))) {
        throw new PortValidationError(`port ${port} is already in use`);
      }
    }
    const token = `reservation-${++this.sequence}`;
    for (const port of values) this.reserved.set(port, token);
    let settled = false;
    const finish = async (release: boolean) => {
      if (settled) return;
      settled = true;
      if (release) for (const port of values) if (this.reserved.get(port) === token) this.reserved.delete(port);
    };
    return { token, ports: values, release: () => finish(true), commit: () => finish(false) };
  }

  isReserved(port: number): boolean {
    return this.reserved.has(port);
  }
}

export function defaultPorts(start = 8000): ProjectPorts {
  validatePort(start, "start");
  return validateProjectPorts({ api: start, dbSession: start + 1000, dbTransaction: start + 2000 });
}
