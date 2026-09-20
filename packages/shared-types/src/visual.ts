import { SensitiveElementType } from './sensitivity';

/**
 * Visual bounding box in pixel coordinates.
 */
export interface VisualBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Coordinate mapping context representing the conversion relationship between
 * screenshot pixels, viewport CSS pixels, and page/document coordinates.
 */
export interface VisualCoordinateContext {
  /** Device Pixel Ratio (window.devicePixelRatio) */
  devicePixelRatio: number;
  /** Current horizontal scroll offset (window.scrollX) */
  scrollX: number;
  /** Current vertical scroll offset (window.scrollY) */
  scrollY: number;
  /** Viewport visible width */
  viewportWidth: number;
  /** Viewport visible height */
  viewportHeight: number;
}

/**
 * Visual finding discovered through local OCR and computer vision.
 *
 * PRIVACY INVARIANT:
 * - This structure MUST NOT contain the raw OCR sensitive text string.
 * - Only the category, confidence, bounding box, and explainability reasons are exported.
 */
export interface VisualFinding {
  id: string;
  category: SensitiveElementType;
  confidence: number;
  boundingBox: VisualBoundingBox;
  pageBoundingBox: VisualBoundingBox;
  reasons: string[];
  redacted: boolean;
}

/**
 * Result of a local visual scan of a rendered viewport / image.
 */
export interface VisualScanResult {
  timestamp: number;
  imageWidth: number;
  imageHeight: number;
  findings: VisualFinding[];
  summary: {
    totalFindings: number;
    sensitiveCount: number;
    byCategory: Record<string, number>;
  };
}
