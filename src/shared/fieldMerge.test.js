import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeField, mergeSnapshot } from "./fieldMerge.js";

test("mergeField: no incoming value keeps stored", () => {
  assert.deepEqual(mergeField("San Francisco", ""), {
    value: "San Francisco",
    conflict: false,
  });
  assert.deepEqual(mergeField("San Francisco", undefined), {
    value: "San Francisco",
    conflict: false,
  });
  assert.deepEqual(mergeField("San Francisco", "   "), {
    value: "San Francisco",
    conflict: false,
  });
});

test("mergeField: nothing stored yet adopts incoming", () => {
  assert.deepEqual(mergeField("", "San Francisco"), {
    value: "San Francisco",
    conflict: false,
  });
  assert.deepEqual(mergeField(undefined, "San Francisco"), {
    value: "San Francisco",
    conflict: false,
  });
});

test("mergeField: both empty stays empty", () => {
  assert.deepEqual(mergeField("", ""), { value: "", conflict: false });
  assert.deepEqual(mergeField(undefined, undefined), {
    value: "",
    conflict: false,
  });
});

test("mergeField: identical values (case/whitespace-insensitive) keeps stored", () => {
  assert.deepEqual(mergeField("Software Engineer", "software engineer"), {
    value: "Software Engineer",
    conflict: false,
  });
  assert.deepEqual(mergeField("Acme Corp", "  Acme   Corp  "), {
    value: "Acme Corp",
    conflict: false,
  });
});

test("mergeField: refine — incoming contains stored, replaces it", () => {
  assert.deepEqual(mergeField("San Francisco", "San Francisco, CA 94105"), {
    value: "San Francisco, CA 94105",
    conflict: false,
  });
});

test("mergeField: keep — stored contains incoming, keeps stored", () => {
  assert.deepEqual(mergeField("San Francisco, CA 94105", "San Francisco"), {
    value: "San Francisco, CA 94105",
    conflict: false,
  });
});

test("mergeField: conflict — neither contains the other, keeps stored and flags it", () => {
  assert.deepEqual(mergeField("Software Engineer", "Product Manager"), {
    value: "Software Engineer",
    conflict: true,
  });
});

test("mergeSnapshot: merges each field independently and collects conflicts", () => {
  const stored = {
    jobTitle: "Software Engineer",
    company: "",
    location: "San Francisco",
  };
  const incoming = {
    jobTitle: "Product Manager", // conflict (neither contains the other)
    company: "Acme Corp", // adopted (nothing stored)
    location: "San Francisco, CA", // refine
  };

  assert.deepEqual(mergeSnapshot(stored, incoming), {
    merged: {
      jobTitle: "Software Engineer",
      company: "Acme Corp",
      location: "San Francisco, CA",
    },
    conflicts: ["jobTitle"],
  });
});

test("mergeSnapshot: no stored snapshot yet adopts everything incoming", () => {
  const incoming = {
    jobTitle: "Software Engineer",
    company: "Acme Corp",
    location: "San Francisco",
  };

  assert.deepEqual(mergeSnapshot(null, incoming), {
    merged: incoming,
    conflicts: [],
  });
});

test("mergeSnapshot: empty incoming snapshot keeps stored untouched", () => {
  const stored = {
    jobTitle: "Software Engineer",
    company: "Acme Corp",
    location: "San Francisco",
  };

  assert.deepEqual(mergeSnapshot(stored, { jobTitle: "", company: "", location: "" }), {
    merged: stored,
    conflicts: [],
  });
});
