// Parses a CSV of job applications for Settings → Import. Pure (no storage,
// no DOM) so it can be unit-tested. Reads Liber's own export (settings.ts's
// CSV_COLUMNS) and the usual spreadsheet headings people track jobs under.
import type { JobStatus } from "./types.ts";

export interface ImportedJob {
  company: string;
  jobTitle: string;
  location: string;
  url: string;
  status: JobStatus;
  dateAdded: string;
  notes: string;
}

export interface CsvImportResult {
  jobs: ImportedJob[];
  // Rows with neither a company nor a job title — nothing to save.
  skipped: number;
  // No company or job title column was found in the header row.
  missingColumns: boolean;
}

type Field = keyof ImportedJob;

// Header text, lowercased with everything but letters/digits removed.
const HEADER_ALIASES: Record<string, Field> = {
  company: "company",
  companyname: "company",
  employer: "company",
  organisation: "company",
  organization: "company",
  jobtitle: "jobTitle",
  title: "jobTitle",
  position: "jobTitle",
  role: "jobTitle",
  location: "location",
  city: "location",
  url: "url",
  link: "url",
  joburl: "url",
  joblink: "url",
  status: "status",
  stage: "status",
  dateapplied: "dateAdded",
  dateadded: "dateAdded",
  date: "dateAdded",
  applied: "dateAdded",
  appliedon: "dateAdded",
  applieddate: "dateAdded",
  notes: "notes",
  note: "notes",
  comments: "notes",
};

// RFC 4180-style: quoted cells may hold the delimiter, newlines and "" for a
// quote. The delimiter is guessed from the header line, since spreadsheets
// in some locales save with ; (or tabs) instead of commas.
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const STATUS_PREFIXES: [string, JobStatus][] = [
  ["interview", "interviewing"],
  ["offer", "offer"],
  ["reject", "rejected"],
  ["withdr", "withdrawn"],
  ["applied", "applied"],
];

function parseStatus(value: string): JobStatus {
  const v = value.trim().toLowerCase();
  return STATUS_PREFIXES.find(([prefix]) => v.startsWith(prefix))?.[1] ?? "applied";
}

function isoDate(y: number, m: number, d: number): string | null {
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// YYYY-MM-DD (Liber's export) as is. a/b/yyyy is read day-first, as UK
// spreadsheets write it, unless only month-first makes sense. Anything else
// the browser can parse ("3 Nov 2026") is accepted; otherwise `fallback`.
export function parseDate(value: string, fallback: string): string {
  const v = value.trim();
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!) ?? fallback;
  m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    const [a, b, y] = [+m[1]!, +m[2]!, +m[3]!];
    return (b > 12 ? isoDate(y, a, b) : isoDate(y, b, a)) ?? fallback;
  }
  const parsed = v ? new Date(v) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return isoDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate()) ?? fallback;
  }
  return fallback;
}

// The export prefixes ' to cells starting with = + - @ so spreadsheets don't
// run them as formulas; importing that file back takes the quote off again.
function cleanCell(value: string | undefined): string {
  const v = (value ?? "").trim();
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}

export function parseJobsCsv(text: string, today: string): CsvImportResult {
  const [header, ...rows] = parseCsv(text);
  const columns = new Map<Field, number>();
  (header ?? []).forEach((name, i) => {
    const field = HEADER_ALIASES[name.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (field && !columns.has(field)) columns.set(field, i);
  });
  if (!columns.has("company") && !columns.has("jobTitle")) {
    return { jobs: [], skipped: 0, missingColumns: true };
  }

  const jobs: ImportedJob[] = [];
  let skipped = 0;
  for (const row of rows) {
    const get = (field: Field) => {
      const i = columns.get(field);
      return i === undefined ? "" : cleanCell(row[i]);
    };
    const company = get("company");
    const jobTitle = get("jobTitle");
    if (!company && !jobTitle) {
      skipped++;
      continue;
    }
    jobs.push({
      company,
      jobTitle,
      location: get("location"),
      url: get("url"),
      status: parseStatus(get("status")),
      dateAdded: parseDate(get("dateAdded"), today),
      notes: get("notes"),
    });
  }
  return { jobs, skipped, missingColumns: false };
}
