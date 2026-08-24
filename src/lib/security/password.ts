import { hash, verify } from "@node-rs/argon2";

const passwordOptions = {
  memoryCost: 19_456,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, passwordOptions);
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await verify(hashValue, password, passwordOptions);
  } catch {
    return false;
  }
}
