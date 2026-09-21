import readXlsxFile from "read-excel-file/node"
import { MAX_FILE_SIZE_BYTES, MAX_PARSED_ROWS } from "./parse-csv"

export interface XlsxParseResult {
  headers: string[]
  records: Record<string, string>[]
  totalParsedRows: number
}

/**
 * Validates and safely parses an XLSX file buffer using read-excel-file (pure JS, safe SAX parser).
 * Enforces:
 * - File size <= 5 MB
 * - Rows <= 500
 * - Rejection of .xlsm, .xls
 * - Content-based rejection of VBA macro containers (vbaProject.bin) even if renamed .xlsx
 * - Magic bytes & OOXML structure validation (rejection of arbitrary zip files)
 * - Safe formula handling (formulas are ignored/never executed; only scalar values read)
 * - Prototype pollution defense (stripping prototype/constructor keys)
 */
export async function parseXlsxContent(buffer: Buffer, filename?: string): Promise<XlsxParseResult> {
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(`Skedari XLSX tejkalon madhësinë maksimale të lejuar prej 5 MB (${(buffer.length / (1024 * 1024)).toFixed(1)} MB).`)
  }

  if (filename) {
    const lower = filename.toLowerCase().trim()
    if (lower.endsWith(".xlsm")) {
      throw new Error("Skedarët me makro (.xlsm) nuk lejohen për arsye sigurie. Ju lutem ruajeni si .xlsx ose .csv.")
    }
    if (lower.endsWith(".xls")) {
      throw new Error("Formati i vjetër .xls nuk mbështetet. Ju lutem ruajeni si .xlsx modern ose .csv.")
    }
    if (!lower.endsWith(".xlsx")) {
      throw new Error("Formati i skedarit nuk mbështetet. Lejohen vetëm skedarë .xlsx ose .csv.")
    }
  }

  // 1. Security check for ZIP/OOXML magic bytes (PK\\x03\\x04)
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
    throw new Error("Skedari nuk është një format i vlefshëm Excel (.xlsx).")
  }

  // 2. Content-based VBA Macro Check (catches real macro workbooks renamed to .xlsx)
  if (
    buffer.includes(Buffer.from("vbaProject.bin")) ||
    buffer.includes(Buffer.from("xl/vbaProject.bin")) ||
    buffer.includes(Buffer.from("vnd.ms-excel.sheet.macroEnabled")) ||
    buffer.includes(Buffer.from("vnd.ms-office.vbaProject"))
  ) {
    throw new Error("Skedari përmban makro (VBA), të cilat nuk lejohen për arsye sigurie.")
  }

  // 3. Validate OOXML package structure within ZIP
  // An arbitrary zip renamed .xlsx will not have standard OOXML markers
  const hasOoxmlMarker =
    buffer.includes(Buffer.from("[Content_Types].xml")) ||
    buffer.includes(Buffer.from("xl/")) ||
    buffer.includes(Buffer.from("xl/workbook.xml"))

  if (!hasOoxmlMarker) {
    throw new Error("Skedari nuk është një dokument i vlefshëm Excel OOXML (.xlsx).")
  }

  // 4. Parse with read-excel-file (pure JS, safe SAX, no formula execution, no prototype pollution)
  let rawSheetData: any[] = []
  try {
    const sheetsResult: any = await readXlsxFile(buffer)
    if (Array.isArray(sheetsResult) && sheetsResult.length > 0) {
      if (Array.isArray(sheetsResult[0]?.data)) {
        rawSheetData = sheetsResult[0].data
      } else if (Array.isArray(sheetsResult[0])) {
        rawSheetData = sheetsResult
      }
    }
  } catch (err: any) {
    throw new Error(`Leximi i skedarit XLSX dështoi: ${err.message || "format i pavlefshëm"}`)
  }

  if (rawSheetData.length === 0) {
    throw new Error("Skedari XLSX nuk përmban asnjë rresht të dhënash.")
  }

  const headerRow = rawSheetData[0] || []
  const headers = headerRow.map((h: any) => (h != null ? String(h).trim() : "")).filter(Boolean)

  if (headers.length === 0) {
    throw new Error("Skedari XLSX nuk përmban kolona të vlefshme në rreshtin e parë.")
  }

  const dataRows = rawSheetData.slice(1)
  if (dataRows.length === 0) {
    throw new Error("Skedari XLSX nuk përmban asnjë rresht të dhënash pas kolonave kryesore.")
  }

  if (dataRows.length > MAX_PARSED_ROWS) {
    throw new Error(`Skedari përmban më shumë se ${MAX_PARSED_ROWS} rreshta. Ju lutem reduktoni madhësinë e skedarit nën ${MAX_PARSED_ROWS} rreshta për importim.`)
  }

  // 5. Convert to Record<string, string> with prototype protection
  const records: Record<string, string>[] = []
  for (const row of dataRows) {
    if (!Array.isArray(row)) continue
    // If entire row is empty/null, skip it
    const hasValues = row.some((cell: any) => cell != null && String(cell).trim() !== "")
    if (!hasValues) continue

    const recordObj: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) {
      const colHeader = headers[i]
      if (colHeader === "__proto__" || colHeader === "constructor" || colHeader === "prototype") {
        continue
      }
      const rawVal = row[i]
      if (rawVal == null) {
        recordObj[colHeader] = ""
      } else if (rawVal instanceof Date) {
        recordObj[colHeader] = rawVal.toISOString().split("T")[0]
      } else {
        recordObj[colHeader] = String(rawVal).trim()
      }
    }
    records.push(recordObj)
  }

  return {
    headers,
    records,
    totalParsedRows: records.length,
  }
}
