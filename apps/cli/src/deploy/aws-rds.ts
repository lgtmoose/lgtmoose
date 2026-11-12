import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
  RDSClient,
  StartDBClusterCommand,
  StartDBInstanceCommand,
} from "@aws-sdk/client-rds";

/** lean runs an RDS instance, standard an Aurora cluster. */
export type DatabaseKind = "instance" | "cluster";

export interface DatabaseControl {
  /**
   * Sets deletion protection directly, without a stack update, so destroy applies nothing else
   * from the checked-out code and works whatever state the stack is in. Works out from RDS
   * whether `identifier` is an instance or a cluster, and starts a stopped database first,
   * because RDS can't modify one. Returns "missing" when no such database exists.
   */
  setDeletionProtection(identifier: string, enabled: boolean): Promise<"done" | "missing">;
}

type RdsCommand =
  | DescribeDBInstancesCommand
  | DescribeDBClustersCommand
  | ModifyDBInstanceCommand
  | ModifyDBClusterCommand
  | StartDBInstanceCommand
  | StartDBClusterCommand;

/** The subset of RDSClient we use, so tests can fake `send`. */
export interface RdsSender {
  send(command: RdsCommand): Promise<{
    DBInstances?: { DBInstanceStatus?: string; DeletionProtection?: boolean }[] | undefined;
    DBClusters?: { Status?: string; DeletionProtection?: boolean }[] | undefined;
  }>;
}

interface Found {
  kind: DatabaseKind;
  status: string;
  deletionProtection: boolean;
}

const POLL_MS = 15_000;
const WAIT_MS = 30 * 60_000;

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

export function rdsDatabaseControl(
  client: RdsSender,
  region: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): DatabaseControl {
  async function find(identifier: string): Promise<Found | undefined> {
    try {
      const { DBInstances } = await client.send(
        new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
      );
      const instance = DBInstances?.[0];
      if (instance) {
        return {
          kind: "instance",
          status: instance.DBInstanceStatus ?? "unknown",
          deletionProtection: instance.DeletionProtection ?? false,
        };
      }
    } catch (error) {
      if (errorName(error) !== "DBInstanceNotFoundFault") throw error;
    }
    try {
      const { DBClusters } = await client.send(
        new DescribeDBClustersCommand({ DBClusterIdentifier: identifier }),
      );
      const cluster = DBClusters?.[0];
      if (cluster) {
        return {
          kind: "cluster",
          status: cluster.Status ?? "unknown",
          deletionProtection: cluster.DeletionProtection ?? false,
        };
      }
    } catch (error) {
      if (errorName(error) !== "DBClusterNotFoundFault") throw error;
    }
    return undefined;
  }

  async function waitUntilAvailable(identifier: string): Promise<Found> {
    for (let waited = 0; ; waited += POLL_MS) {
      const found = await find(identifier);
      if (found === undefined) throw new Error(`${identifier} disappeared while waiting for it`);
      if (found.status === "available") return found;
      if (waited >= WAIT_MS) {
        throw new Error(`${identifier} is still ${found.status} after 30 minutes`);
      }
      await sleep(POLL_MS);
    }
  }

  return {
    async setDeletionProtection(identifier, enabled) {
      try {
        let found = await find(identifier);
        if (found === undefined) return "missing";
        if (found.deletionProtection === enabled) return "done";
        if (found.status === "stopped") {
          await client.send(
            found.kind === "instance"
              ? new StartDBInstanceCommand({ DBInstanceIdentifier: identifier })
              : new StartDBClusterCommand({ DBClusterIdentifier: identifier }),
          );
        }
        if (found.status !== "available") found = await waitUntilAvailable(identifier);
        await client.send(
          found.kind === "instance"
            ? new ModifyDBInstanceCommand({
                DBInstanceIdentifier: identifier,
                DeletionProtection: enabled,
                ApplyImmediately: true,
              })
            : new ModifyDBClusterCommand({
                DBClusterIdentifier: identifier,
                DeletionProtection: enabled,
                ApplyImmediately: true,
              }),
        );
        await waitUntilAvailable(identifier);
        return "done";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `AWS RDS (${region}) couldn't turn deletion protection ${enabled ? "on" : "off"} for ${identifier}: ${message}`,
          { cause: error },
        );
      }
    },
  };
}

export function createDatabaseControl(region: string): DatabaseControl {
  return rdsDatabaseControl(new RDSClient({ region }), region);
}
