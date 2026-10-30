// Imported shows set the PDF page where printed script numbering starts.
export let FIRST_SCRIPT_PDF_PAGE = 1;
export function configureScriptPages(firstPage: number) { FIRST_SCRIPT_PDF_PAGE = firstPage; }

export function scriptPageNumber(pdfPage: number) {
  return pdfPage - FIRST_SCRIPT_PDF_PAGE + 1;
}

export function pdfPageNumber(scriptPage: number) {
  return scriptPage + FIRST_SCRIPT_PDF_PAGE - 1;
}

export function scriptPageCount(pdfPageCount: number) {
  return Math.max(0, scriptPageNumber(pdfPageCount));
}
