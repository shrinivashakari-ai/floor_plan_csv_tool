import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanRing } from "./cleanPolygon.js";
import { parseAreaCsv, applyCleanup, exportCleanedCsv, mergeParsedCsvs, buildExportForSlot } from "./csv.js";
import { shoelaceArea } from "./geometry.js";

describe("cleanRing", () => {
  it("collapses near-duplicate corners on an L-shape", () => {
    const dirty = [
      { x: 0, y: 0 },
      { x: 0.01, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0.02 },
      { x: 10, y: 4 },
      { x: 10.02, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 4.01 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
      { x: 0.02, y: 10 },
      { x: 0, y: 0.02 },
    ];
    const result = cleanRing(dirty, { snapEps: 0.05, collinearTol: 0.05, loopAreaTol: 0.1 });
    assert.equal(result.cleanedCount, 6);
    assert.ok(result.cleanedArea > 0);
    assert.ok(result.areaDeltaPct < 2);
  });

  it("removes a zero-width spike", () => {
    const dirty = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 10.01, y: 0.01 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ];
    const result = cleanRing(dirty, { snapEps: 0.05, collinearTol: 0.05, loopAreaTol: 1 });
    assert.ok(result.cleanedCount <= 4);
    assert.ok(Math.abs(result.cleanedArea - 50) < 1);
  });

  it("drops a jittered extra on a long straight wall", () => {
    const dirty = [
      { x: 0, y: 0 },
      { x: 50, y: 0.4 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ];
    const result = cleanRing(dirty, { snapEps: 1, collinearTol: 1, loopAreaTol: 2, simplifyEps: 1 });
    assert.equal(result.cleanedCount, 4);
    assert.ok(Math.abs(result.cleanedArea - 6000) < 50);
  });

  it("drops collinear extras on a rectangle", () => {
    const dirty = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 6 },
      { x: 0, y: 6 },
      { x: 0, y: 3 },
    ];
    const result = cleanRing(dirty, { snapEps: 0.01, collinearTol: 0.01, loopAreaTol: 0.1 });
    assert.equal(result.cleanedCount, 4);
    assert.ok(Math.abs(result.cleanedArea - 60) < 0.01);
  });

  it("removes only the last terminal tail on KITCHEN-1/Z-4_3", () => {
    const dirty = [
      { x: 421, y: 369 },
      { x: 744, y: 369 },
      { x: 744, y: 411 },
      { x: 700, y: 412 },
      { x: 700, y: 471 },
      { x: 659, y: 471 },
      { x: 659, y: 549 },
      { x: 421, y: 549 },
      { x: 421, y: 370 },
    ];
    const result = cleanRing(dirty, { snapEps: 0.5, collinearTol: 0.5, simplifyEps: 0.5, closeEps: 2 });
    assert.equal(result.cleanedCount, 8);
    assert.equal(result.cleaned[0].x, 421);
    assert.equal(result.cleaned[0].y, 369);
    assert.equal(result.cleaned[7].x, 421);
    assert.equal(result.cleaned[7].y, 549);
    assert.ok(result.issues.some((i) => i.type === "terminal-tail"));
  });

  it("exports a square as exactly 4 coordinates and drops the auto-close tail", () => {
    const csv = [
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name",
      "1,Building,1st Floor,,200,SQUARE,0~0,10~0,10~10,0~10,0~1",
    ].join("\n");
    const parsed = applyCleanup(parseAreaCsv(csv), { snapEps: 0.5, collinearTol: 0.5, simplifyEps: 0.5, closeEps: 2 });
    assert.equal(parsed.areas[0].cleanedCount, 4);
    const out = exportCleanedCsv(parsed);
    const coords = out.trim().split(/\r?\n/)[1].split(",").slice(6);
    assert.equal(coords.length, 4);
    assert.equal(coords[0], "0~0");
    assert.notEqual(coords[3], "0~1");
    assert.notEqual(coords[3], "0~0");
  });
});

describe("csv lutron round-trip", () => {
  it("parses x~y cells, cleans, and keeps metadata columns", () => {
    const csv = [
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name,,,",
      "1,Building,1st Floor,,101,RECEPTION AREA,0~0,0.01~0,10~0,10~0.02,10~4,4~4,4~10,0~10",
    ].join("\n");
    const parsed = applyCleanup(parseAreaCsv(csv), { snapEps: 0.05, collinearTol: 0.05, loopAreaTol: 0.1 });
    assert.equal(parsed.format, "lutron");
    assert.equal(parsed.areas[0].name, "RECEPTION AREA");
    assert.equal(parsed.areas[0].code, "101");
    assert.ok(parsed.areas[0].cleanedCount <= 6);
    const out = exportCleanedCsv(parsed);
    assert.match(out, /RECEPTION AREA/);
    assert.match(out, /101/);
    assert.match(out, /0~0/);
    assert.ok(!out.includes("0.01~0"));
  });

  it("does not write a closing duplicate that overlaps the first point", () => {
    const csv = [
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name",
      "1,Building,1st Floor,,101,LOBBY AREA,0~0,10~0,10~6,0~6,0~0",
    ].join("\n");
    const parsed = applyCleanup(parseAreaCsv(csv), { snapEps: 0.05, collinearTol: 0.05, loopAreaTol: 0.1, simplifyEps: 0.05 });
    const out = exportCleanedCsv(parsed);
    const row = out.trim().split(/\r?\n/)[1];
    const cells = row.split(",");
    const coords = cells.slice(6);
    assert.equal(coords[0], "0~0");
    assert.notEqual(coords[coords.length - 1], "0~0");
    assert.equal(coords.filter((c) => c === "0~0").length, 1);
    assert.ok(parsed.areas[0].cleanedCount <= 4);
  });

  it("parses long-format name,x,y", () => {
    const csv = ["name,x,y", "LOBBY AREA,0,0", "LOBBY AREA,10,0", "LOBBY AREA,10,6", "LOBBY AREA,5,6", "LOBBY AREA,0,6"].join("\n");
    const parsed = applyCleanup(parseAreaCsv(csv), { snapEps: 0.01, collinearTol: 0.01, loopAreaTol: 0.1 });
    assert.equal(parsed.format, "long");
    assert.equal(parsed.areas[0].cleanedCount, 4);
    assert.ok(Math.abs(parsed.areas[0].cleanedArea - 60) < 0.01);
    assert.ok(shoelaceArea(parsed.areas[0].cleanedRings[0]) > 0);
  });

  it("merges two CSVs and keeps unique areas", () => {
    const a = parseAreaCsv([
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name",
      "1,Building,1st Floor,,101,RECEPTION AREA,0~0,10~0,10~6,0~6",
    ].join("\n"));
    const b = parseAreaCsv([
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name",
      "1,Building,1st Floor,,102,LOBBY AREA,20~0,30~0,30~6,20~6",
    ].join("\n"));
    const merged = mergeParsedCsvs([a, b]);
    assert.equal(merged.areas.length, 2);
    assert.ok(merged.areas.some((area) => area.name === "RECEPTION AREA"));
    assert.ok(merged.areas.some((area) => area.name === "LOBBY AREA"));
  });

  it("accepts a second-processor CSV whose first rooms have no coordinates", () => {
    const emptyRows = Array.from({ length: 40 }, (_, i) => `7,Building,2F,,16${i},WS OS-${i}`);
    const csv = [
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name",
      ...emptyRows,
      "7,Building,2F,,17008,WS OS-188,2274~1434,2276~1435,2276~1506,2137~1506",
    ].join("\n");
    const parsed = parseAreaCsv(csv);
    assert.equal(parsed.format, "lutron");
    assert.equal(parsed.areas.length, 41);
    const drawn = parsed.areas.filter((a) => a.rings[0]?.length);
    assert.equal(drawn.length, 1);
    assert.equal(drawn[0].name, "WS OS-188");
    assert.equal(drawn[0].rings[0].length, 4);
  });

  it("merges complementary processor CSVs by code+name and skips empty rings", () => {
    const a = parseAreaCsv([
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name",
      "1,Building,2F,,16228,WS OS-1,232~117,388~117,388~197,232~197",
      "1,Building,2F,,17008,WS OS-188",
    ].join("\n"));
    const b = parseAreaCsv([
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name",
      "7,Building,2F,,16228,WS OS-1",
      "7,Building,2F,,17008,WS OS-188,2274~1434,2276~1506,2137~1506,2137~1435",
    ].join("\n"));
    const merged = mergeParsedCsvs([a, b]);
    assert.equal(merged.areas.length, 2);
    const os1 = merged.areas.find((area) => area.name === "WS OS-1");
    const os188 = merged.areas.find((area) => area.name === "WS OS-188");
    assert.equal(os1.rings[0].length, 4);
    assert.equal(os188.rings[0].length, 4);
  });

  it("parses Lutron rows that use 421,369 instead of 421~369", () => {
    const csv = [
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name",
      "7,Building,2nd Floor,,17008,WS OS-188,421,369,744,369,744,411,421,411",
    ].join("\n");
    const parsed = parseAreaCsv(csv);
    assert.equal(parsed.format, "lutron");
    assert.equal(parsed.areas[0].name, "WS OS-188");
    assert.equal(parsed.areas[0].rings[0].length, 4);
    assert.equal(parsed.areas[0].rings[0][0].x, 421);
    assert.equal(parsed.areas[0].rings[0][0].y, 369);
  });

  it("on duplicate area keeps the row with more vertices", () => {
    const thin = parseAreaCsv([
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name",
      "1,Building,1st Floor,,101,RECEPTION AREA,0~0,10~0,10~6,0~6",
    ].join("\n"));
    const rich = parseAreaCsv([
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name",
      "1,Building,1st Floor,,101,RECEPTION AREA,0~0,10~0,10~4,4~4,4~10,0~10",
    ].join("\n"));
    const merged = mergeParsedCsvs([thin, rich]);
    assert.equal(merged.areas.length, 1);
    assert.equal(merged.areas[0].rings[0].length, 6);
  });

  it("download keeps manually deleted vertices instead of re-cleaning originals", () => {
    const csv = [
      "processor_id,root_area,root_subarea,root_sub_subarea,code,name",
      "1,Building,1st Floor,,101,LOBBY,0~0,10~0,10~6,5~6,0~6",
    ].join("\n");
    const source = parseAreaCsv(csv);
    const cleaned = applyCleanup(source, { snapEps: 0.05, collinearTol: 0.05, closeEps: 2 });
    const edited = {
      ...cleaned.areas[0],
      cleanedRings: [cleaned.areas[0].cleanedRings[0].slice(0, 4)],
      cleanedCount: 4,
    };
    const forExport = buildExportForSlot(source, [edited], { snapEps: 0.05, collinearTol: 0.05, closeEps: 2 });
    const coords = exportCleanedCsv(forExport).trim().split(/\r?\n/)[1].split(",").slice(6);
    assert.equal(coords.length, 4);
    assert.equal(forExport.areas[0].cleanedCount, 4);
  });
});
