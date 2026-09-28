/ src/dashboard/dashboard.js
import { getAllJobs, updateJob, deleteJob, getProfile, STATUS, STATUS_META } from "../shared/storage.js";

const tbody = document.getElementById("jobs-tbody");
const emptyState = document.getElementById("empty-state");
const greeting = document.getElementById("greeting");

async function renderGreeting() {
  const profile = await getProfile();
  if (profile) {
    greeting.textContent = `${profile.name} — tracking ${profile.profession} roles`;
  }
}

function buildStatusSelect(job) {
  const select = document.createElement("select");
  select.className = `dashboard__select dashboard__select--${job.status}`;

  Object.entries(STATUS_META).forEach(([value, meta]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = meta.label;
    if (value === job.status) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener("change", async () => {
    await updateJob(job.id, { status: select.value });
    select.className = `dashboard__select dashboard__select--${select.value}`;
  });

  return select;
}

function buildEditableCell(job, field) {
  const td = document.createElement("td");
  td.textContent = job[field] || "";
  td.contentEditable = "true";
  td.addEventListener("blur", async () => {
    await updateJob(job.id, { [field]: td.textContent.trim() });
  });
  return td;
}

function buildRow(job) {
  const tr = document.createElement("tr");

  const companyTd = document.createElement("td");
  companyTd.textContent = job.company;
  tr.appendChild(companyTd);

  const titleTd = document.createElement("td");
  const link = document.createElement("a");
  link.href = job.url;
  link.target = "_blank";
  link.textContent = job.jobTitle;
  titleTd.appendChild(link);
  tr.appendChild(titleTd);

  const platformTd = document.createElement("td");
  platformTd.textContent = job.platform;
  tr.appendChild(platformTd);

  const locationTd = document.createElement("td");
  locationTd.textContent = job.location;
  tr.appendChild(locationTd);

  const dateTd = document.createElement("td");
  dateTd.textContent = new Date(job.dateAdded).toLocaleDateString();
  tr.appendChild(dateTd);

  const statusTd = document.createElement("td");
  statusTd.appendChild(buildStatusSelect(job));
  tr.appendChild(statusTd);

  tr.appendChild(buildEditableCell(job, "notes"));

  const actionsTd = document.createElement("td");
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "dashboard__delete";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", async () => {
    await deleteJob(job.id);
    tr.remove();
  });
  actionsTd.appendChild(deleteBtn);
  tr.appendChild(actionsTd);

  return tr;
}

async function renderJobs() {
  const jobs = await getAllJobs();
  tbody.innerHTML = "";

  if (jobs.length === 0) {
    emptyState.classList.remove("dashboard__empty--hidden");
    return;
  }

  emptyState.classList.add("dashboard__empty--hidden");
  jobs.forEach((job) => tbody.appendChild(buildRow(job)));
}

renderGreeting();
renderJobs();

// Re-render if storage changes from another context (e.g. a new job just saved).
browser.storage.onChanged.addListener((changes) => {
  if (changes.liber_jobs) renderJobs();
});