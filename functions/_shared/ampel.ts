// Ampel-Beschriftung. Eigenes Modul, damit trend3.ts sie nutzen kann, ohne
// scoring.ts zu importieren - sonst entstuende der Kreis
// scoring -> region -> trend3 -> scoring.
export function ampelLabel(a: number | null) {
  if (a === null) return "grau";
  return a === 1 ? "gruen" : a === 0.5 ? "gelb" : "rot";
}
