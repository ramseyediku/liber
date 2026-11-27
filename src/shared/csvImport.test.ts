import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseDate, parseJobsCsv } from "./csvImport.ts";

const TODAY = "2026-11-27";

test("parseCsv: quoted cells keep commas, newlines and escaped quotes", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","line1\nline2"\r\n"say ""hi""",z\r\n'), [
    ["a", "b"],
    ["x, y", "line1\nline2"],
    ['say "hi"', "z"],
  ]);
});

test("parseCsv: strips a BOM, skips blank lines, detects ; and tab delimiters", () => {
  assert.deepEqual(parseCsv("﻿a;b\n\n1;2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
});

test("parseJobsCsv: reads Liber's own export back", () => {
  const csv =
    "Job profile,Company,Job title,Location,Status,Date applied,URL,Notes\r\n" +
    "General,Acme,Engineer,London,Interviewing,2026-10-02,https://acme.test/1,'=SUM(A1)";
  const result = parseJobsCsv(csv, TODAY);
  assert.equal(result.missingColumns, false);
  assert.deepEqual(result.jobs, [
    {
      company: "Acme",
      jobTitle: "Engineer",
      location: "London",
      url: "https://acme.test/1",
      status: "interviewing",
      dateAdded: "2026-10-02",
      notes: "=SUM(A1)",
    },
  ]);
});

test("parseJobsCsv: common headings, unknown status and missing date", () => {
  const result = parseJobsCsv("Employer,Position,Stage\nGlobex,Analyst,Phone screen", TODAY);
  assert.equal(result.jobs[0]!.company, "Globex");
  assert.equal(result.jobs[0]!.jobTitle, "Analyst");
  assert.equal(result.jobs[0]!.status, "applied");
  assert.equal(result.jobs[0]!.dateAdded, TODAY);
});

test("parseJobsCsv: rows with no company or title are skipped", () => {
  const result = parseJobsCsv("Company,Job title,Notes\n,,just a note\nAcme,,", TODAY);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.skipped, 1);
});

test("parseJobsCsv: no company or title column", () => {
  assert.equal(parseJobsCsv("Foo,Bar\n1,2", TODAY).missingColumns, true);
  assert.equal(parseJobsCsv("", TODAY).missingColumns, true);
});

test("parseDate: ISO, day-first, month-first when unambiguous, fallback", () => {
  assert.equal(parseDate("2026-03-04", TODAY), "2026-03-04");
  assert.equal(parseDate("04/03/2026", TODAY), "2026-03-04");
  assert.equal(parseDate("03/25/2026", TODAY), "2026-03-25");
  assert.equal(parseDate("31/02/2026", TODAY), TODAY);
  assert.equal(parseDate("not a date", TODAY), TODAY);
  assert.equal(parseDate("", TODAY), TODAY);
});
