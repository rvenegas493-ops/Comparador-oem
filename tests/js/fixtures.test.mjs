// Auditoría automática de los fixtures. El repositorio es público: todo lo que está aquí
// es visible para cualquiera. Esta prueba falla si un fixture contiene datos que no deben publicarse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(RAIZ, "tests", "fixtures");
const EJEMPLO = path.join(RAIZ, "ejemplo");

// Patrones que no deben aparecer en ningún fixture.
const PROHIBIDOS = [
  { nombre: "correo electrónico", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { nombre: "URL", re: /https?:\/\// },
  { nombre: "ruta local del equipo", re: /\/(home|root|Users|mnt|tmp|var)\/|[A-Za-z]:\\/ },
  { nombre: "dirección IP", re: /\b\d{1,3}(\.\d{1,3}){3}\b/ },
  { nombre: "número de identificación de vehículo (VIN)", re: /\b[A-HJ-NPR-Z0-9]{17}\b/ },
  { nombre: "posible secreto", re: /(token|password|contraseña|secret|api[_-]?key)/i },
];

const sha256 = (ruta) => createHash("sha256").update(readFileSync(ruta)).digest("hex");
const ficheros = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));

test("hay fixtures que auditar", () => {
  assert.ok(ficheros.length >= 2);
});

for (const nombre of ficheros) {
  const texto = readFileSync(path.join(FIXTURES, nombre), "utf-8");

  test(`${nombre}: no contiene datos sensibles`, () => {
    for (const { nombre: tipo, re } of PROHIBIDOS) {
      const m = texto.match(re);
      assert.equal(m, null, `encontrado ${tipo}: ${m?.[0]}`);
    }
  });

  test(`${nombre}: metadatos normalizados y hashes coherentes con los ejemplos publicados`, () => {
    const entradas = JSON.parse(texto);
    const esperados = {
      "export_a.csv": sha256(path.join(EJEMPLO, "export_a.csv")),
      "export_b.csv": sha256(path.join(EJEMPLO, "export_b.csv")),
      "diccionario.csv (ejemplo)": sha256(path.join(EJEMPLO, "diccionario.csv")),
    };
    for (const e of entradas) {
      assert.match(e.id, /^\d{13}-[a-z0-9]+$/, "identificador normalizado");
      assert.ok(!Number.isNaN(Date.parse(e.fecha)), "fecha ISO válida");
      for (const campo of [e.a, e.b, e.d]) {
        assert.equal(campo.sha256, esperados[campo.nombre], `hash de ${campo.nombre} coincide con el ejemplo publicado`);
      }
    }
  });
}
