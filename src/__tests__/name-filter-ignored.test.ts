import { describe, expect, it } from "vitest";
import { nameFilterWasIgnored } from "../mcp-server.js";

describe("nameFilterWasIgnored", () => {
  it("is false when every record's name contains the filter (case-insensitive)", () => {
    expect(nameFilterWasIgnored([{ name: "Veeam DR Runbook" }, { name: "veeam" }], "VEEAM")).toBe(false);
  });

  it("is true when any record's name does not contain the filter", () => {
    expect(nameFilterWasIgnored([{ name: "Veeam DR" }, { name: "debug.log" }], "veeam")).toBe(true);
  });

  it("ignores records without a string name", () => {
    expect(nameFilterWasIgnored([{ id: 1 }, null, { name: 5 }, { name: "Veeam" }], "veeam")).toBe(false);
  });

  it("is false for an empty result", () => {
    expect(nameFilterWasIgnored([], "veeam")).toBe(false);
  });
});
