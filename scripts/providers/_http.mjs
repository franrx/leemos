export async function httpError(r) {
  const body = (await r.text().catch(() => '')).slice(0, 300);
  const e = new Error(`HTTP ${r.status} ${r.statusText}: ${body}`);
  e.status = r.status;
  return e;
}
