import { describe, expect, it } from "vitest";
import type { AuditRow } from "../../src/worker/audit.ts";
import {
  AUDIT_COLUMNS,
  auditCsvHeader,
  auditCsvLine,
  csvCell,
  csvLine,
  exportRange,
  metricsCsv,
  parseDay,
} from "../../src/worker/export-format.ts";

const DAY = 86_400_000;

describe("SITE-06 csv: formula injection", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])("prefixes %j with an apostrophe", (cell) => {
    expect(csvCell(cell).replace(/^"/, "").startsWith("'")).toBe(true);
  });

  it("leaves safe text alone and quotes commas, quotes and newlines", () => {
    expect(csvCell("Deck")).toBe("Deck");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(0)).toBe("0");
  });

  it("neutralizes a hostile file name in a full row, even when it also needs quoting", () => {
    const row: AuditRow = {
      id: 1,
      sessionId: "s",
      at: 0,
      actor: "phone",
      type: "approved",
      detail: { fileName: '=HYPERLINK("http://x","y")' },
      roomName: "+Room",
      userEmail: "@a.example",
      mode: "live",
      kind: "owner",
    };
    const line = auditCsvLine(row);
    expect(line).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(line).toContain(",'+Room,");
    expect(line).toContain(",'@a.example,");
    expect(auditCsvHeader()).toBe(csvLine(AUDIT_COLUMNS));
  });

  it("applies the same guard to the metrics file", () => {
    const csv = metricsCsv([{ mode: "live", name: "failure", cause: "=cmd", n: 1, p50Ms: null, p90Ms: null }]);
    expect(csv).toContain("'=cmd");
  });
});

describe("export range", () => {
  const now = Date.parse("2026-03-10T12:00:00Z");
  it("parses real days only", () => {
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("2026-2-3")).toBeNull();
    expect(parseDay(null)).toBeNull();
    expect(parseDay("2026-03-01")).toBe(Date.parse("2026-03-01T00:00:00Z"));
  });

  it("treats to as an inclusive day and defaults to the last 30 days ending today", () => {
    const r = exportRange("2026-03-01", "2026-03-03", now);
    expect(r).toMatchObject({ from: Date.parse("2026-03-01T00:00:00Z"), to: Date.parse("2026-03-04T00:00:00Z") });
    expect(r?.label).toBe("2026-03-01..2026-03-03");
    expect(r?.fileLabel).toBe("2026-03-01_2026-03-03");
    const d = exportRange(null, null, now);
    expect(d?.to).toBe(Date.parse("2026-03-11T00:00:00Z"));
    expect(d && d.to - d.from).toBe(30 * DAY);
  });

  it("refuses a reversed, malformed or over-long range", () => {
    expect(exportRange("2026-03-05", "2026-03-01", now)).toBeNull();
    expect(exportRange("nope", null, now)).toBeNull();
    expect(exportRange("2026-01-01", "bad", now)).toBeNull();
    expect(exportRange("2024-01-01", "2026-03-01", now)).toBeNull();
  });
});
