---
name: desk-artifacts
description: Create and edit local DOCX, XLSX, PPTX and PDF artifacts in Sub2API Desk using the installed Python libraries. Does not operate cloud document editors.
---

# Local artifacts

Call `desk_tools.runtime_info` to locate the dedicated Python environment and Poppler. Use python-docx for DOCX, openpyxl for XLSX, python-pptx for PPTX, pypdf/pdfplumber for reading PDFs and reportlab for PDF creation. Run scripts from the user's project using Codex's terminal tool. Keep generated files in the authorized project.

Preserve source documents on edits. Verify document structure by reopening the result. For spreadsheets, check formulas, formats and ranges; openpyxl does not calculate formulas, so do not claim recalculation unless actually performed by a calculation engine.

Render PDFs with pdftoppm and visually inspect images before delivery. For DOCX/PPTX rendering, first check for an available Office or LibreOffice renderer; if none is available, report that visual rendering was not verified. Structural validation alone does not prove page layout. Do not silently replace the requested format with a PDF.

For PDF-specific edits, also read the discovered PDF plugin skill and follow its form validation and render workflow. For plotting and scientific figures, use the relevant installed plotting skill. Local source skills and original plugin assets remain unchanged.

These libraries do not provide official live cloud editors, native Google Docs import, official template galleries or cloud artifact sessions. Use a connected service only when it is actually available and authorized.
