/** The scale used by the desktop viewer before the responsive fit is applied. */
export const DEFAULT_PDF_SCALE = 1.35;

export type PdfZoomGeometryOptions = {
  frameWidth: number;
  reservedWidth: number;
  requestedScale: number;
  pageWidth: number;
  pageOffset?: number;
  baseScale?: number;
  minimumFitScale?: number;
};

export type PdfZoomGeometry = {
  fitScale: number;
  renderedScale: number;
  horizontallyScrollable: boolean;
};

/**
 * Fit the default page to the available column, then apply the user's zoom
 * as a multiplier of that fit. This keeps the default layout unchanged while
 * allowing zoom controls to work when the fit scale is below the control's
 * absolute scale values (as it is on phones).
 */
export function getPdfZoomGeometry({
  frameWidth,
  reservedWidth,
  requestedScale,
  pageWidth,
  pageOffset = reservedWidth,
  baseScale = DEFAULT_PDF_SCALE,
  minimumFitScale = 0.12,
}: PdfZoomGeometryOptions): PdfZoomGeometry {
  const fitScale = Math.max(minimumFitScale, (frameWidth - reservedWidth) / pageWidth);
  const defaultRenderedScale = Math.min(baseScale, fitScale);
  const safeRequestedScale = Number.isFinite(requestedScale) ? requestedScale : baseScale;
  const renderedScale = defaultRenderedScale * (safeRequestedScale / baseScale);
  const horizontallyScrollable = pageWidth * renderedScale + pageOffset > frameWidth + 0.5;
  return { fitScale, renderedScale, horizontallyScrollable };
}
