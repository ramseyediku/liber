import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasCoreFields,
  hasCoreSelectors,
  sanitizeSelectors,
  selectorsReproduce,
  valuesMatch,
} from "./structure.ts";

const snap = (jobTitle = "", company = "", location = "") => ({ jobTitle, company, location });

test("sanitizeSelectors: keeps plain CSS, trims", () => {
  assert.deepEqual(
    sanitizeSelectors({ jobTitle: " h1.job-title ", company: "[data-testid='co']", location: "" }),
    { jobTitle: "h1.job-title", company: "[data-testid='co']", location: "" },
  );
});

test("sanitizeSelectors: drops markup, blocks, overlong and non-standard selectors", () => {
  assert.equal(
    sanitizeSelectors({
      jobTitle: "<script>",
      company: "a{color:red}",
      location: "span:contains(Remote)",
    }),
    null,
  );
  assert.equal(sanitizeSelectors({ jobTitle: "a".repeat(201), company: "", location: "" }), null);
});

test("sanitizeSelectors: non-objects and non-strings", () => {
  assert.equal(sanitizeSelectors(null), null);
  assert.equal(sanitizeSelectors("h1"), null);
  assert.deepEqual(sanitizeSelectors({ jobTitle: 5, company: "h2", location: null }), {
    jobTitle: "",
    company: "h2",
    location: "",
  });
});

test("hasCoreSelectors / hasCoreFields: need title and company, location optional", () => {
  assert.equal(hasCoreSelectors({ jobTitle: "h1", company: "h2", location: "" }), true);
  assert.equal(hasCoreSelectors({ jobTitle: "h1", company: "", location: "x" }), false);
  assert.equal(hasCoreSelectors(null), false);
  assert.equal(hasCoreFields(snap("Dev", "Acme")), true);
  assert.equal(hasCoreFields(snap("Dev", "")), false);
  assert.equal(hasCoreFields(null), false);
});

test("valuesMatch: equal, case/space-insensitive, and a bounded containment", () => {
  assert.equal(valuesMatch("Software Engineer", "  software   engineer "), true);
  assert.equal(valuesMatch("Software Engineer", "Software Engineer II"), true);
  assert.equal(valuesMatch("Engineer", "Engineer " + "x".repeat(40)), false); // grabbed a whole card
  assert.equal(valuesMatch("Engineer", "Designer"), false);
  assert.equal(valuesMatch("", "Designer"), false);
});

test("selectorsReproduce: every proposed selector must read back its value", () => {
  const selectors = { jobTitle: "h1", company: ".co", location: ".loc" };
  const expected = snap("Dev", "Acme", "London");
  assert.equal(selectorsReproduce(selectors, expected, snap("Dev", "Acme", "London")), true);
  assert.equal(selectorsReproduce(selectors, expected, snap("Dev", "Other", "London")), false);
});

test("selectorsReproduce: a field with no selector or no expected value is not held against it", () => {
  const expected = snap("Dev", "Acme", "");
  assert.equal(
    selectorsReproduce({ jobTitle: "h1", company: ".co", location: ".loc" }, expected, snap("Dev", "Acme", "junk")),
    true,
  );
  assert.equal(
    selectorsReproduce({ jobTitle: "h1", company: ".co", location: "" }, snap("Dev", "Acme", "London"), snap("Dev", "Acme", "")),
    true,
  );
});

test("selectorsReproduce: rejects a structure missing a core selector", () => {
  assert.equal(
    selectorsReproduce({ jobTitle: "h1", company: "", location: "" }, snap("Dev", "Acme"), snap("Dev", "Acme")),
    false,
  );
});
