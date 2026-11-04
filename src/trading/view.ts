const escape = (v: unknown) => String(v ?? "indisponible").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const amount = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "indisponible";

/** Served only behind the guardian's observer authentication or the dashboard's authenticated backend. */
export function renderTradingView(r: any): string {
  const cards = [
    ["Mode / état", `${r.mode ?? "disabled"} / ${r.state ?? "unknown"}`],
    ["Valeur du portefeuille (USDC)", amount(r.wallet?.equityQuote)],
    ["Résultat net estimé (USDC)", amount(r.performance?.estimatedNetPnlQuote)],
    ["Baisse maximale estimée (%)", amount(r.performance?.maxDrawdownPct)],
    ["Exposition ETH / WETH (USDC)", amount(r.exposures?.ethQuote)],
    ["Exposition USDC", amount(r.exposures?.usdcQuote)],
    ["Stratégie étudiée", r.study?.strategy],
    ["Rendement hors échantillon (%)", amount(r.study?.outOfSample?.netReturnPct)],
    ["Simple détention, même étude (%)", amount(r.study?.outOfSample?.benchmarkReturnPct)],
    ["Simulation prospective : résultat (USDC virtuels)", amount(r.paper?.netPnlQuote)],
    ["Limite d'inférence du jour (centimes USD)", r.inference?.dailyLimitCents],
    ["Inférence déjà comptabilisée (estimation, centimes USD)", r.inference?.recordedCents],
  ];
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trading Automaton</title>
<style>body{background:#0e1420;color:#e7edf7;font:16px system-ui;max-width:1100px;margin:30px auto;padding:20px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}article{padding:18px;background:#1d293b;border-radius:12px}small{color:#b4c2d8}strong{display:block;margin-top:9px;font-size:21px}table{width:100%;text-align:left;margin-top:25px}td,th{padding:9px;border-bottom:1px solid #334155}a{color:#6ee7cb}</style>
<h1>Trading Automaton</h1><p>${escape(r.reason)}</p><p><small>Portefeuille ${escape(r.walletAddress)} · Base · ${escape(r.updatedAt ? new Date(r.updatedAt).toISOString() : "aucune lecture")}</small></p>
<main>${cards.map(([k, v]) => `<article><small>${escape(k)}</small><strong>${escape(v)}</strong></article>`).join("")}</main>
<p>Le portefeuille est la poche de capital. Les dépenses de services et le budget Claude sont distincts. Les simulations ne sont pas des recettes. Les pertes de marché peuvent consommer la poche.</p>
<p><small>${escape(r.accounting ?? r.fees)} ${escape(r.study?.warning ?? "")}</small></p>
<h2>Dernières transactions</h2><table><thead><tr><th>Étape</th><th>État</th><th>Transaction</th></tr></thead><tbody>${(r.transactions ?? []).slice(0, 30).map((t: any) => `<tr><td>${escape(t.stage)}</td><td>${escape(t.state)}</td><td>${/^0x[0-9a-f]{64}$/i.test(t.hash ?? "") ? `<a rel="noreferrer" target="_blank" href="https://basescan.org/tx/${escape(t.hash)}">${escape(t.hash.slice(0, 16))}…</a>` : "aucune"}</td></tr>`).join("")}</tbody></table></html>`;
}
