import { awsError, errorName } from "../aws-errors.js";
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
  RDSClient,
  StartDBClusterCommand,
  StartDBInstanceCommand,
  StopDBClusterCommand,
  StopDBInstanceCommand,
} from "@aws-sdk/client-rds";

/**
 * Both profiles run an RDS instance. A cluster is still handled for a deployment made when
 * `standard` created Aurora.
 */
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
  | StartDBClusterCommand
  | StopDBInstanceCommand
  | StopDBClusterCommand;

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

/**
 * States in which RDS refuses ModifyDB* until the database settles. Anything else (available,
 * storage-optimization, backing-up, maintenance, configuring-…) accepts a DeletionProtection
 * change, so there's no need to wait out a storage optimization that can take hours.
 */
const BUSY = new Set([
  "creating",
  "starting",
  "stopping",
  "stopped",
  "rebooting",
  "modifying",
  "renaming",
  "resetting-master-credentials",
  "upgrading",
]);

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

  return {
    async setDeletionProtection(identifier, enabled) {
      let started = false;
      let modified = false;
      try {
        for (let waited = 0; ; waited += POLL_MS) {
          const found = await find(identifier);
          // Being deleted counts as gone: it will never be available again.
          if (found === undefined || found.status === "deleting") return "missing";
          if (found.deletionProtection === enabled) {
            // A database this call started to change it goes back to stopped, so turning
            // protection on doesn't leave it running and billing. (Turning it off is for
            // destroy, which deletes it next.)
            if (!started || !enabled) return "done";
            if (found.status === "available") {
              await client.send(
                found.kind === "instance"
                  ? new StopDBInstanceCommand({ DBInstanceIdentifier: identifier })
                  : new StopDBClusterCommand({ DBClusterIdentifier: identifier }),
              );
              return "done";
            }
          } else if (found.status === "stopped" && !started) {
            // RDS can't modify a stopped database. A "stopping" one is waited on until it's
            // stopped, then started.
            await client.send(
              found.kind === "instance"
                ? new StartDBInstanceCommand({ DBInstanceIdentifier: identifier })
                : new StartDBClusterCommand({ DBClusterIdentifier: identifier }),
            );
            started = true;
          } else if (!BUSY.has(found.status) && !modified) {
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
            modified = true;
            continue;
          }
          if (waited >= WAIT_MS) {
            throw new Error(`${identifier} is still ${found.status} after 30 minutes`);
          }
          await sleep(POLL_MS);
        }
      } catch (error) {
        throw awsError(
          "RDS",
          region,
          `turning deletion protection ${enabled ? "on" : "off"} for ${identifier}`,
          error,
        );
      }
    },
  };
}

export function createDatabaseControl(region: string): DatabaseControl {
  return rdsDatabaseControl(new RDSClient({ region }), region);
}
