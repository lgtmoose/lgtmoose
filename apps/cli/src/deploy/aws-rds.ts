import {
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
  RDSClient,
  waitUntilDBClusterAvailable,
  waitUntilDBInstanceAvailable,
} from "@aws-sdk/client-rds";

/** lean runs an RDS instance, standard an Aurora cluster. */
export type DatabaseKind = "instance" | "cluster";

export interface DatabaseControl {
  /**
   * Turns deletion protection off directly, so destroy doesn't have to redeploy the Data stack
   * (which would also apply whatever else changed in the checked-out code).
   */
  disableDeletionProtection(kind: DatabaseKind, identifier: string): Promise<void>;
}

const WAIT_SECONDS = 30 * 60;

export function createDatabaseControl(region: string): DatabaseControl {
  const client = new RDSClient({ region });
  return {
    async disableDeletionProtection(kind, identifier) {
      try {
        if (kind === "instance") {
          await client.send(
            new ModifyDBInstanceCommand({
              DBInstanceIdentifier: identifier,
              DeletionProtection: false,
              ApplyImmediately: true,
            }),
          );
          await waitUntilDBInstanceAvailable(
            { client, maxWaitTime: WAIT_SECONDS },
            { DBInstanceIdentifier: identifier },
          );
        } else {
          await client.send(
            new ModifyDBClusterCommand({
              DBClusterIdentifier: identifier,
              DeletionProtection: false,
              ApplyImmediately: true,
            }),
          );
          await waitUntilDBClusterAvailable(
            { client, maxWaitTime: WAIT_SECONDS },
            { DBClusterIdentifier: identifier },
          );
        }
      } catch (error) {
        // Already deleted, for example by an earlier destroy that got further: nothing to do.
        if (error instanceof Error && /NotFound/.test(error.name)) return;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `AWS RDS (${region}) couldn't turn off deletion protection on ${identifier}: ${message}`,
          { cause: error },
        );
      }
    },
  };
}
