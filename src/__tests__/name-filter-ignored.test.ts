import { describe, expect, it } from "vitest";
import { nameFilterWasIgnored } from "../mcp-server.js";

describe("nameFilterWasIgnored", () => {
  it("is false when every record's name equals the filter (case-insensitive, trimmed)", () => {
    expect(nameFilterWasIgnored([{ name: "Veeam DR Runbook" }, { name: " veeam dr runbook " }], "VEEAM DR RUNBOOK")).toBe(false);
  });

  it("is true when a record's name only contains the filter", () => {
    // An honoured exact-match filter never returns "Veeam DR" for "veeam".
    expect(nameFilterWasIgnored([{ name: "Veeam DR" }], "veeam")).toBe(true);
  });

  it("is true when any record's name differs", () => {
    expect(nameFilterWasIgnored([{ name: "veeam" }, { name: "debug.log" }], "veeam")).toBe(true);
  });

  it("ignores records without a string name", () => {
    expect(nameFilterWasIgnored([{ id: 1 }, null, { name: 5 }, { name: "Veeam" }], "veeam")).toBe(false);
  });

  it("is false for an empty result", () => {
    expect(nameFilterWasIgnored([], "veeam")).toBe(false);
  });
});
