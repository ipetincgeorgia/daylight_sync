const bookingInput = document.getElementById("bookingInput");
const queryBtn = document.getElementById("queryBtn");
const clearBtn = document.getElementById("clearBtn");
const messageEl = document.getElementById("message");
const resultsBody = document.getElementById("resultsBody");
const dashboards = document.getElementById("dashboards");
let currentRecords = [];
let selectedRecordIndex = -1;

queryBtn.addEventListener("click", runQuery);
clearBtn.addEventListener("click", resetView);
resultsBody.addEventListener("click", onTableClick);

async function runQuery() {
  const raw = bookingInput.value;
  const bookingNumbers = raw
    .split(/[\n,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (bookingNumbers.length === 0) {
    setMessage("Please enter at least one booking or probill number.", true);
    return;
  }

  setMessage(`Querying ${bookingNumbers.length} reference(s)...`);
  queryBtn.disabled = true;

  try {
    const response = await fetch("/api/daylight/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingNumbers }),
    });

    const payload = await response.json();

    if (!response.ok) {
      const endpointHint = payload?.endpoint ? ` Endpoint: ${payload.endpoint}` : "";
      throw new Error((payload?.message || "Failed to query Daylight API.") + endpointHint);
    }

    currentRecords = payload.records || [];
    selectedRecordIndex = currentRecords.length > 0 ? 0 : -1;
    renderMappingTable(currentRecords, selectedRecordIndex);
    renderSingleDashboard(currentRecords[selectedRecordIndex]);
    setMessage(`Loaded ${payload.returned} result(s).`);
  } catch (error) {
    currentRecords = [];
    selectedRecordIndex = -1;
    renderMappingTable([], -1);
    renderSingleDashboard(null);
    setMessage(error.message || "Request failed.", true);
  } finally {
    queryBtn.disabled = false;
  }
}

function renderMappingTable(records, activeIndex = -1) {
  if (!records.length) {
    resultsBody.innerHTML = `
      <tr>
        <td colspan="2" class="empty">No data found.</td>
      </tr>
    `;
    return;
  }

  resultsBody.innerHTML = records
    .map(
      (record, index) => `
      <tr class="result-row ${index === activeIndex ? "result-row--active" : ""}" data-record-index="${index}">
        <td>${escapeHtml(record.bookingNumber || "")}</td>
        <td>${escapeHtml(record.proNumber || "-")}</td>
      </tr>
    `
    )
    .join("");
}

function renderSingleDashboard(record) {
  if (!record) {
    dashboards.innerHTML = "<p class=\"empty\">Click a shipment in pane 2 to view details.</p>";
    return;
  }

  const rawJson = escapeHtml(formatJson(record.raw || {}));
  const stationItems = (record.stations || [])
    .slice(0, 8)
    .map((station) => {
      const parts = [station.name, [station.city, station.state].filter(Boolean).join(", "), station.status, station.eta]
        .filter(Boolean)
        .map((part) => escapeHtml(part));

      return `<li>${parts.join(" • ")}</li>`;
    })
    .join("");

  dashboards.innerHTML = `
    <article class="dashboard-card">
      <div class="dashboard-head">
        <h3>Booking ${escapeHtml(record.bookingNumber || "")}</h3>
        <p>PRO: ${escapeHtml(record.proNumber || "-")}</p>
      </div>

      <div class="meta-grid">
        <div class="meta">
          <span>Status</span>
          <strong>${escapeHtml(record.status || "Unknown")}</strong>
        </div>
        <div class="meta">
          <span>Shipping Location</span>
          <strong>${escapeHtml(record.shippingLocation || "-")}</strong>
        </div>
        <div class="meta">
          <span>Consignee</span>
          <strong>${escapeHtml(record.consignee || "-")}</strong>
        </div>
        <div class="meta">
          <span>Stations</span>
          <strong>${Number(record.stations?.length || 0)}</strong>
        </div>
      </div>

      ${stationItems ? `<ol class="station-list">${stationItems}</ol>` : "<p class=\"empty\">No station events returned.</p>"}

      <details class="raw-panel">
        <summary>Show raw API response</summary>
        <pre>${rawJson}</pre>
      </details>
    </article>
  `;
}

function resetView() {
  bookingInput.value = "";
  currentRecords = [];
  selectedRecordIndex = -1;
  renderMappingTable([], -1);
  renderSingleDashboard(null);
  setMessage("Cleared.");
}

function onTableClick(event) {
  const row = event.target.closest("tr[data-record-index]");
  if (!row) {
    return;
  }

  const nextIndex = Number.parseInt(row.dataset.recordIndex || "-1", 10);
  if (Number.isNaN(nextIndex) || nextIndex < 0 || nextIndex >= currentRecords.length) {
    return;
  }

  selectedRecordIndex = nextIndex;
  renderMappingTable(currentRecords, selectedRecordIndex);
  renderSingleDashboard(currentRecords[selectedRecordIndex]);
}

function setMessage(message, isError = false) {
  messageEl.textContent = message;
  messageEl.style.color = isError ? "var(--warning)" : "var(--ink-soft)";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return "{}";
  }
}
