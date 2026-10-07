// Naht fuer die News-Quelle. analyse/index.ts holt News nur noch ueber
// fetchNews(); eine andere Quelle ersetzt die Implementierung hier, nicht den
// Aufrufer. Der Statusvertrag (NewsStatus, siehe dataFlags.ts) bleibt gleich.
import { classifyNewsStatus, type FmpResultLike, type NewsSource, type NewsStatus } from "./dataFlags.ts";

export interface NewsResult {
  // Leer, wenn die Quelle nichts lieferte oder der Zugriff verweigert war.
  items: any[];
  status: NewsStatus;
  source: NewsSource;
}

// fmpFetch ruft einen FMP-Pfad ab und liefert die Form von fmpGet() in
// analyse/index.ts (inkl. Logging in api_call_log).
export async function fetchNews(
  ticker: string,
  fmpFetch: (path: string) => Promise<FmpResultLike>,
): Promise<NewsResult> {
  const res = await fmpFetch(`/news/stock?symbols=${ticker}&limit=20`);
  return {
    items: res.ok && Array.isArray(res.data) ? res.data : [],
    status: classifyNewsStatus(res),
    source: "fmp",
  };
}
