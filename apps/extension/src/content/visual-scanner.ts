import {
  SensitiveElementType,
  type VisualBoundingBox,
  type VisualCoordinateContext,
  type VisualFinding,
  type VisualScanResult,
} from '@veilbrowse/shared-types';

/**
 * Raw OCR Token detected by local visual perception.
 * Kept STRICTLY local — never included in outbound payloads.
 */
export interface OcrToken {
  text: string;
  bbox: VisualBoundingBox;
}

/**
 * Regex patterns for identifying visual PII.
 */
const PATTERNS = {
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i,
  PHONE: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/,
  IDENTITY_SSN: /\b\d{3}-\d{2}-\d{4}\b/,
  IDENTITY_GENERIC: /\b(?:ID|PASSPORT|SSN|AADHAAR|ACCOUNT)[:\s#-]*[A-Z0-9-]{5,}\b/i,
  PAYMENT_CARD: /\b(?:\d{4}[ -]?){3}\d{4}\b/,
  PAYMENT_CVV: /\b(?:cvv|cvc|csc)[:\s]*\d{3,4}\b/i,
  ADDRESS_KEYWORDS: /\b(?:\d+\s+[A-Za-z0-9\s,.-]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Terrace|Ter|Court|Ct|Way|Lane|Ln|Drive|Dr|Suite|Apt))\b/i,
  PASSWORD: /\b(?:password|pwd|passcode|secret)[:\s]*\S+\b/i,
};

/**
 * Coordinate mapping: translates screenshot pixels to viewport CSS pixels and page coordinates.
 */
export function mapCoordinates(
  bbox: VisualBoundingBox,
  context: VisualCoordinateContext
): { viewport: VisualBoundingBox; page: VisualBoundingBox } {
  const dpr = context.devicePixelRatio || 1;
  const viewport: VisualBoundingBox = {
    x: Math.round(bbox.x / dpr),
    y: Math.round(bbox.y / dpr),
    width: Math.round(bbox.width / dpr),
    height: Math.round(bbox.height / dpr),
  };

  const page: VisualBoundingBox = {
    x: viewport.x + (context.scrollX || 0),
    y: viewport.y + (context.scrollY || 0),
    width: viewport.width,
    height: viewport.height,
  };

  return { viewport, page };
}

/**
 * Local Visual Sensitive Data Detector
 * Analyzes local OCR tokens to identify sensitive regions.
 *
 * PRIVACY GUARANTEE:
 * Returns VisualFinding[] containing metadata and coordinates ONLY.
 * Raw OCR text strings are deliberately discarded.
 */
export function detectVisualSensitiveRegions(
  tokens: OcrToken[],
  coordContext: VisualCoordinateContext
): VisualFinding[] {
  const findings: VisualFinding[] = [];
  let counter = 0;

  for (const token of tokens) {
    const text = token.text.trim();
    if (!text) continue;

    let category: SensitiveElementType | null = null;
    let confidence = 0.0;
    const reasons: string[] = [];

    if (PATTERNS.PASSWORD.test(text)) {
      category = SensitiveElementType.PASSWORD;
      confidence = 0.95;
      reasons.push('visual text matches password/credential pattern');
    } else if (PATTERNS.EMAIL.test(text)) {
      category = SensitiveElementType.EMAIL;
      confidence = 0.95;
      reasons.push('visual text matches email pattern');
    } else if (PATTERNS.PAYMENT_CARD.test(text) || PATTERNS.PAYMENT_CVV.test(text)) {
      category = SensitiveElementType.PAYMENT;
      confidence = 0.92;
      reasons.push('visual text matches payment card or CVV pattern');
    } else if (PATTERNS.IDENTITY_SSN.test(text) || PATTERNS.IDENTITY_GENERIC.test(text)) {
      category = SensitiveElementType.IDENTITY;
      confidence = 0.90;
      reasons.push('visual text matches identity/SSN pattern');
    } else if (PATTERNS.PHONE.test(text)) {
      category = SensitiveElementType.PHONE;
      confidence = 0.88;
      reasons.push('visual text matches phone format');
    } else if (PATTERNS.ADDRESS_KEYWORDS.test(text)) {
      category = SensitiveElementType.ADDRESS;
      confidence = 0.85;
      reasons.push('visual text contains physical street address structure');
    }

    if (category) {
      counter += 1;
      const { page } = mapCoordinates(token.bbox, coordContext);

      findings.push({
        id: `vf-${counter}`,
        category,
        confidence,
        boundingBox: token.bbox,
        pageBoundingBox: page,
        reasons,
        redacted: false,
      });
    }
  }

  return findings;
}

/**
 * Local Visual Redactor.
 * Applies opaque masking rectangles over sensitive bounding boxes on a local canvas context.
 * The original unredacted image pixels remain strictly local.
 */
export function applyVisualRedaction(
  canvas: {
    getContext: (type: '2d') => {
      fillStyle: string;
      fillRect: (x: number, y: number, w: number, h: number) => void;
    } | null;
  },
  findings: VisualFinding[]
): VisualFinding[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return findings;

  return findings.map((finding) => {
    ctx.fillStyle = '#111827'; // Opaque dark mask
    ctx.fillRect(
      finding.boundingBox.x,
      finding.boundingBox.y,
      finding.boundingBox.width,
      finding.boundingBox.height
    );

    return {
      ...finding,
      redacted: true,
    };
  });
}

/**
 * Executes a local visual scan on OCR tokens.
 * Assembles the sanitized visual scan result.
 */
export function scanVisual(
  tokens: OcrToken[],
  coordContext: VisualCoordinateContext,
  imageWidth: number,
  imageHeight: number
): VisualScanResult {
  const findings = detectVisualSensitiveRegions(tokens, coordContext);
  const byCategory: Record<string, number> = {};

  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  }

  return {
    timestamp: Date.now(),
    imageWidth,
    imageHeight,
    findings,
    summary: {
      totalFindings: findings.length,
      sensitiveCount: findings.length,
      byCategory,
    },
  };
}
