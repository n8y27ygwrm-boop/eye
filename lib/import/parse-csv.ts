import { parse } from "csv-parse/sync"

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB
export const MAX_PARSED_ROWS = 500

export interface CsvParseResult {
  headers: string[]
  records: Record<string, string>[]
  totalParsedRows: number
}

/**
 * Parses raw CSV string or buffer into structured records.
 * Enforces max 5 MB and max 500 rows limit.
 */
export function parseCsvContent(content: string | Buffer): CsvParseResult {
  const byteLength = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, "utf8")
  if (byteLength > MAX_FILE_SIZE_BYTES) {
    throw new Error(`Skedari CSV tejkalon madhësinë maksimale të lejuar prej 5 MB (${(byteLength / (1024 * 1024)).toFixed(1)} MB).`)
  }

  const csvString = Buffer.isBuffer(content) ? content.toString("utf8") : content

  if (!csvString.trim()) {
    throw new Error("Skedari CSV është bosh.")
  }

  // Parse up to MAX_PARSED_ROWS + 1 to detect overflow
  const rawRows: Record<string, string>[] = parse(csvString, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
    to: MAX_PARSED_ROWS + 1,
  })

  if (rawRows.length === 0) {
    throw new Error("Skedari CSV nuk përmban asnjë rresht të dhënash.")
  }

  if (rawRows.length > MAX_PARSED_ROWS) {
    throw new Error(`Skedari përmban më shumë se ${MAX_PARSED_ROWS} rreshta. Ju lutem reduktoni madhësinë e skedarit nën ${MAX_PARSED_ROWS} rreshta për importim.`)
  }

  const headers = Object.keys(rawRows[0] || {})

  return {
    headers,
    records: rawRows,
    totalParsedRows: rawRows.length,
  }
}
