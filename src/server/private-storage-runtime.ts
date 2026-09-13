import { pool } from "./db";
import { releaseOutputStorage, reserveOutputStorage, usesCloudStorage } from "./private-storage";

export async function reserveCreationStorage(operationId: string) {
  if (usesCloudStorage()) await reserveOutputStorage(pool, operationId);
}

export async function releaseCreationStorage(operationId: string) {
  if (usesCloudStorage()) await releaseOutputStorage(pool, operationId);
}
