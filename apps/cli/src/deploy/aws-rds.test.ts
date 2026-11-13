import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
  StartDBInstanceCommand,
} from "@aws-sdk/client-rds";
import { describe, expect, it, vi } from "vitest";
import { rdsDatabaseControl, type RdsSender } from "./aws-rds.js";

function fault(name: string): Error {
  return Object.assign(new Error(`${name} happened`), { name });
}

/** A fake RDS holding one instance or cluster, which becomes available after a start. */
function fakeRds(db: {
  kind: "instance" | "cluster" | "none";
  status?: string;
  /** Statuses reported on later describes, after the first. */
  then?: string[];
  protection?: boolean;
  modifyFails?: Error;
}) {
  let status = db.status ?? "available";
  const later = [...(db.then ?? [])];
  const next = () => {
    const current = status;
    status = later.shift() ?? status;
    return current;
  };
  let protection = db.protection ?? true;
  const send = vi.fn<RdsSender["send"]>((command) => {
    if (command instanceof DescribeDBInstancesCommand) {
      if (db.kind !== "instance") return Promise.reject(fault("DBInstanceNotFoundFault"));
      return Promise.resolve({
        DBInstances: [{ DBInstanceStatus: next(), DeletionProtection: protection }],
      });
    }
    if (command instanceof DescribeDBClustersCommand) {
      if (db.kind !== "cluster") return Promise.reject(fault("DBClusterNotFoundFault"));
      return Promise.resolve({ DBClusters: [{ Status: next(), DeletionProtection: protection }] });
    }
    if (command instanceof ModifyDBInstanceCommand || command instanceof ModifyDBClusterCommand) {
      if (db.modifyFails) return Promise.reject(db.modifyFails);
      protection = command.input.DeletionProtection ?? protection;
      return Promise.resolve({});
    }
    status = command.constructor.name.startsWith("Stop") ? "stopped" : "available";
    return Promise.resolve({});
  });
  const control = rdsDatabaseControl({ send }, "eu-west-2", () => Promise.resolve());
  const sent = () => send.mock.calls.map(([command]) => command.constructor.name);
  return { control, send, sent, protection: () => protection };
}

describe("rdsDatabaseControl", () => {
  it("finds an instance and turns its protection off", async () => {
    const rds = fakeRds({ kind: "instance" });
    await expect(rds.control.setDeletionProtection("db-1", false)).resolves.toBe("done");
    expect(rds.protection()).toBe(false);
    expect(rds.sent()).toContain("ModifyDBInstanceCommand");
    expect(rds.sent()).not.toContain("ModifyDBClusterCommand");
  });

  it("finds a cluster by asking for an instance first", async () => {
    const rds = fakeRds({ kind: "cluster" });
    await expect(rds.control.setDeletionProtection("cluster-1", false)).resolves.toBe("done");
    expect(rds.sent()).toContain("ModifyDBClusterCommand");
  });

  it("starts a stopped database before modifying it", async () => {
    const rds = fakeRds({ kind: "instance", status: "stopped" });
    await rds.control.setDeletionProtection("db-1", false);
    const sent = rds.sent();
    expect(sent.indexOf(StartDBInstanceCommand.name)).toBeLessThan(
      sent.indexOf(ModifyDBInstanceCommand.name),
    );
    expect(rds.protection()).toBe(false);
  });

  it("waits for a stopping database to stop, then starts it", async () => {
    const rds = fakeRds({ kind: "instance", status: "stopping", then: ["stopped"] });
    await expect(rds.control.setDeletionProtection("db-1", false)).resolves.toBe("done");
    expect(rds.sent()).toContain("StartDBInstanceCommand");
    expect(rds.protection()).toBe(false);
  });

  it("treats a database being deleted as gone instead of waiting on it", async () => {
    const rds = fakeRds({ kind: "instance", status: "deleting", protection: false });
    await expect(rds.control.setDeletionProtection("db-1", true)).resolves.toBe("missing");
    expect(rds.sent()).toEqual(["DescribeDBInstancesCommand"]);
  });

  it("modifies during a long storage optimization instead of waiting it out", async () => {
    const rds = fakeRds({ kind: "instance", status: "storage-optimization" });
    await expect(rds.control.setDeletionProtection("db-1", false)).resolves.toBe("done");
    expect(rds.protection()).toBe(false);
  });

  it("stops a database again after starting it to turn protection on", async () => {
    const rds = fakeRds({ kind: "instance", status: "stopped", protection: false });
    await expect(rds.control.setDeletionProtection("db-1", true)).resolves.toBe("done");
    expect(rds.protection()).toBe(true);
    expect(rds.sent()).toContain("StopDBInstanceCommand");
  });

  it("leaves it running after turning protection off, since destroy deletes it next", async () => {
    const rds = fakeRds({ kind: "instance", status: "stopped" });
    await rds.control.setDeletionProtection("db-1", false);
    expect(rds.sent()).not.toContain("StopDBInstanceCommand");
  });

  it("does nothing when protection is already as asked", async () => {
    const rds = fakeRds({ kind: "instance", protection: true, status: "stopped" });
    await rds.control.setDeletionProtection("db-1", true);
    expect(rds.sent()).toEqual(["DescribeDBInstancesCommand"]);
  });

  it("reports a database that doesn't exist as either kind", async () => {
    const rds = fakeRds({ kind: "none" });
    await expect(rds.control.setDeletionProtection("db-1", false)).resolves.toBe("missing");
  });

  it("names the database and region when RDS fails", async () => {
    const rds = fakeRds({ kind: "instance", modifyFails: fault("AccessDenied") });
    await expect(rds.control.setDeletionProtection("db-1", false)).rejects.toThrow(
      "AWS RDS (eu-west-2) failed on turning deletion protection off for db-1",
    );
  });
});
