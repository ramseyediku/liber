import { test } from "node:test";
import assert from "node:assert/strict";
import { tryParseCompleteSnapshot } from "./partialJsonSnapshot.js";

test("tryParseCompleteSnapshot: returns null on an empty/partial buffer", () => {
  assert.equal(tryParseCompleteSnapshot(""), null);
  assert.equal(tryParseCompleteSnapshot('{"jobTitle": "Softw'), null);
  assert.equal(
    tryParseCompleteSnapshot('{"jobTitle": "Software Engineer", "company":'),
    null,
  );
});

test("tryParseCompleteSnapshot: matches as soon as the third field closes, before the closing brace", () => {
  const buffer =
    '{"jobTitle": "Software Engineer", "company": "Acme", "location": "Remote"';
  assert.deepEqual(tryParseCompleteSnapshot(buffer), {
    jobTitle: "Software Engineer",
    company: "Acme",
    location: "Remote",
  });
});

test("tryParseCompleteSnapshot: still matches once the full object (with closing brace) has arrived", () => {
  const buffer =
    '{"jobTitle": "Software Engineer", "company": "Acme", "location": "Remote"}';
  assert.deepEqual(tryParseCompleteSnapshot(buffer), {
    jobTitle: "Software Engineer",
    company: "Acme",
    location: "Remote",
  });
});

test("tryParseCompleteSnapshot: decodes escaped characters in values", () => {
  const buffer =
    '{"jobTitle": "Senior \\"Staff\\" Engineer", "company": "Acme\\\\Corp", "location": "Remote"';
  assert.deepEqual(tryParseCompleteSnapshot(buffer), {
    jobTitle: 'Senior "Staff" Engineer',
    company: "Acme\\Corp",
    location: "Remote",
  });
});

test("tryParseCompleteSnapshot: tolerates empty-string fields", () => {
  const buffer = '{"jobTitle": "", "company": "", "location": ""';
  assert.deepEqual(tryParseCompleteSnapshot(buffer), {
    jobTitle: "",
    company: "",
    location: "",
  });
});

test("tryParseCompleteSnapshot: does not match out-of-order fields", () => {
  const buffer = '{"location": "Remote", "company": "Acme", "jobTitle": "PM"';
  assert.equal(tryParseCompleteSnapshot(buffer), null);
});
