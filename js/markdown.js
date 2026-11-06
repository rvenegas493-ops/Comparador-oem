// Renderizador Markdown mínimo para el subconjunto que produce generarReporte().
// Todo el texto se escapa antes de aplicar formato: los datos del archivo nunca
// se interpretan como HTML.

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

// Divide una fila de tabla respetando el escape \| de las celdas.
function celdas(linea) {
  const t = linea.trim().replace(/\\\|/g, "\u0000");
  const sinBordes = t.replace(/^\|/, "").replace(/\|$/, "");
  return sinBordes.split("|").map((p) => p.replace(/\u0000/g, "|").trim());
}

export function mdToHtml(md) {
  const lineas = md.split("\n");
  const out = [];
  let i = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    if (l.startsWith("|")) {
      const filas = [];
      while (i < lineas.length && lineas[i].startsWith("|")) {
        filas.push(lineas[i]);
        i++;
      }
      const [cabecera, , ...cuerpo] = filas;
      const th = celdas(cabecera).map((c) => `<th>${inline(c)}</th>`).join("");
      const tr = cuerpo
        .map((f) => "<tr>" + celdas(f).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>")
        .join("");
      out.push(`<div class="tabla"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
      continue;
    }
    const h = l.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const n = h[1].length;
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      i++;
      continue;
    }
    if (l.startsWith(">")) {
      const bloque = [];
      while (i < lineas.length && lineas[i].startsWith(">")) {
        bloque.push(lineas[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(bloque.join(" "))}</blockquote>`);
      continue;
    }
    if (l.startsWith("- ")) {
      const items = [];
      while (i < lineas.length && lineas[i].startsWith("- ")) {
        items.push(lineas[i].slice(2));
        i++;
      }
      out.push("<ul>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ul>");
      continue;
    }
    const par = [];
    while (i < lineas.length && lineas[i].trim() && !/^(#|>|\||- )/.test(lineas[i])) {
      par.push(lineas[i]);
      i++;
    }
    out.push(`<p>${inline(par.join(" "))}</p>`);
  }
  return out.join("\n");
}

const ESTILO_DOCUMENTO = `
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:16px;line-height:1.45;max-width:760px;color:#111}
h1{font-size:22px}h2{font-size:18px;margin-top:24px;border-bottom:2px solid #0f3b57;padding-bottom:4px}
.tabla{overflow-x:auto;margin:8px 0}
table{border-collapse:collapse;font-size:14px;min-width:100%}
th,td{border:1px solid #c9d1d9;padding:6px;text-align:left;vertical-align:top}
th{background:#eef2f5}
blockquote{margin:8px 0;padding:8px 12px;background:#fff7e0;border-left:4px solid #e0a800}
code{word-break:break-all;background:#f2f2f2;padding:0 3px;border-radius:3px}
@media print{body{max-width:none}}`;

export function htmlDocumento(md, titulo = "Reporte de comparación") {
  return (
    "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    `<title>${esc(titulo)}</title><style>${ESTILO_DOCUMENTO}</style></head><body>` +
    mdToHtml(md) +
    "</body></html>"
  );
}
