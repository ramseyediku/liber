import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJobPostingLd } from "./jobPostingLd.js";

test("parseJobPostingLd: plain JobPosting object", () => {
  const roots = [
    {
      "@type": "JobPosting",
      title: "Software Engineer",
      hiringOrganization: { name: "Acme Corp" },
      jobLocation: {
        address: { addressLocality: "San Francisco", addressRegion: "CA" },
      },
    },
  ];
  assert.deepEqual(parseJobPostingLd(roots), {
    jobTitle: "Software Engineer",
    company: "Acme Corp",
    location: "San Francisco, CA",
  });
});

test("parseJobPostingLd: hiringOrganization as a bare string", () => {
  const roots = [
    {
      "@type": "JobPosting",
      title: "Designer",
      hiringOrganization: "Acme Corp",
      jobLocation: null,
    },
  ];
  assert.deepEqual(parseJobPostingLd(roots), {
    jobTitle: "Designer",
    company: "Acme Corp",
    location: "",
  });
});

test("parseJobPostingLd: jobLocation as an array, first entry with an address wins", () => {
  const roots = [
    {
      "@type": "JobPosting",
      title: "Analyst",
      hiringOrganization: { name: "Acme Corp" },
      jobLocation: [
        {},
        { address: { addressLocality: "Remote" } },
        { address: { addressLocality: "Austin", addressRegion: "TX" } },
      ],
    },
  ];
  assert.deepEqual(parseJobPostingLd(roots), {
    jobTitle: "Analyst",
    company: "Acme Corp",
    location: "Remote",
  });
});

test("parseJobPostingLd: unwraps @graph", () => {
  const roots = [
    {
      "@graph": [
        { "@type": "WebPage" },
        {
          "@type": "JobPosting",
          title: "Data Scientist",
          hiringOrganization: { name: "Acme Corp" },
        },
      ],
    },
  ];
  assert.deepEqual(parseJobPostingLd(roots), {
    jobTitle: "Data Scientist",
    company: "Acme Corp",
    location: "",
  });
});

test("parseJobPostingLd: a bare array root", () => {
  const roots = [
    [
      { "@type": "Organization", name: "Acme Corp" },
      { "@type": "JobPosting", title: "PM" },
    ],
  ];
  assert.deepEqual(parseJobPostingLd(roots), {
    jobTitle: "PM",
    company: "",
    location: "",
  });
});

test("parseJobPostingLd: no JobPosting anywhere returns all-empty", () => {
  const roots = [{ "@type": "Organization", name: "Acme Corp" }];
  assert.deepEqual(parseJobPostingLd(roots), {
    jobTitle: "",
    company: "",
    location: "",
  });
});

test("parseJobPostingLd: no roots at all", () => {
  assert.deepEqual(parseJobPostingLd([]), {
    jobTitle: "",
    company: "",
    location: "",
  });
});

test("parseJobPostingLd: a JobPosting with no extractable fields is skipped in favor of a later one", () => {
  const roots = [
    { "@type": "JobPosting" },
    { "@type": "JobPosting", title: "Second Posting" },
  ];
  assert.deepEqual(parseJobPostingLd(roots), {
    jobTitle: "Second Posting",
    company: "",
    location: "",
  });
});
