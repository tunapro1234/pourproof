// Snapshot -> chain view, roles, and the numbers the passport computes in the browser.
import { describe, expect, it } from "vitest";
import { eventsOf } from "../src/chain.ts";
import { carbonView, readingsOf, strengthView, STRENGTH_LABEL } from "../src/compute.ts";
import { accountRoles, roleName, ROLE_ID } from "../src/roles.ts";
import { batchesOf, evidence, inputs, snapshot, view } from "./fixtures.ts";

describe("snapshot view", () => {
  it("carries the labels every screen shows", () => {
    expect(view.source).toBe("snapshot");
    expect(view.sourceLabel).toBe(`recorded on-chain state, block ${snapshot.block}`);
    expect(view.networkLabel).toBe("local Anvil");
    expect(view.timeMode).toBe("advanced");
    expect(Object.keys(view.pours)).toEqual(["P-001", "P-002"]);
  });

  it("role ids match the contract's keccak256 names; the saving was claimed by the supplier", () => {
    const claim = eventsOf(view, view.pours["P-001"].pourId, "SavingClaimed");
    expect(claim).toHaveLength(1);
    expect(roleName(String(claim[0].args.role))).toBe("supplier");
    expect(ROLE_ID.supplier).toBe(claim[0].args.role);
    const roles = accountRoles(view.events);
    expect(roles.get(String(claim[0].args.claimant).toLowerCase())).toEqual(["supplier"]);
    expect(eventsOf(view, view.pours["P-002"].pourId, "SavingClaimed")).toEqual([]);
  });

  it("keeps the refused calls (a reverted transaction has no event): P-001's reused ticket and second claim, P-002's batches and claim", () => {
    const r1 = view.pours["P-001"].rejected;
    expect(r1.map((r) => [r.role, r.fn, r.revert?.name])).toEqual([
      ["supplier", "createPour", "TicketReused"],
      ["contractor", "claimSaving", "AlreadyClaimed"],
    ]);
    expect(r1.every((r) => r.kind === "transaction")).toBe(true);
    expect(String(r1[0].revert!.args[0])).toBe(view.pours["P-001"].state.pour.ticketHash);
    expect(String(r1[1].revert!.args[1]).toLowerCase()).toBe(view.pours["P-001"].state.pour.claimant.toLowerCase());
    expect(view.pours["P-002"].rejected.map((r) => [r.fn, r.revert?.name])).toEqual([
      ["appendBatch", "BadSignature"],
      ["appendBatch", "CounterGap"],
      ["claimSaving", "StrengthNotApproved"],
    ]);
  });
});

describe("passport numbers", () => {
  const p1 = batchesOf("P-001");
  const readings = readingsOf(p1.batches, Number(view.pours["P-001"].state.pour.pourStart));

  it("maturity and strength recomputed in the browser equal the evidence package hashed on chain", () => {
    const sv = strengthView(readings, evidence.strength.fit);
    expect(sv.lastM).toBe(evidence.maturity.maturity_ch);
    expect(sv.checkpoints).toEqual(evidence.strength.checkpoints);
    expect(evidence.strength.label).toBe(STRENGTH_LABEL);
    for (const c of sv.checkpoints) expect(c.strength.high_mpa).toBeGreaterThan(c.strength.low_mpa);
  });

  it("CO2 is a range; the saving range equals the ledger's savingRange", () => {
    const pour = inputs.pours["P-001"];
    const c = carbonView(pour.volume_m3, inputs.mixes[pour.delivered_mix], inputs.mixes[pour.baseline_mix!]);
    expect(c.delivered).toEqual({ low_kg: 8 * 306, high_kg: 8 * 326 });
    expect([c.saving!.low_kg, c.saving!.high_kg].map(String)).toEqual(view.pours["P-001"].state.savingRange);
    const c2 = carbonView(8, inputs.mixes[inputs.pours["P-002"].delivered_mix], null);
    expect(c2.saving).toBeNull();
  });
});
