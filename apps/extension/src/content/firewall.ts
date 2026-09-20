import {
  SensitiveElementType,
  REDACTION_TOKENS,
  type DomScanResult,
  type VisualScanResult,
  type VisualFinding,
  type ScannedElement,
  type ElementBounds,
  type VisualBoundingBox,
  type UnifiedFinding,
  type SanitizedVisualRegion,
  type UnifiedSanitizedContext,
} from '@veilbrowse/shared-types';
import { prepareSanitizedContext } from './redactor';

/**
 * Calculates overlap ratio between two bounding boxes.
 */
export function calculateBoxOverlap(
  boxA: ElementBounds | VisualBoundingBox,
  boxB: ElementBounds | VisualBoundingBox
): number {
  const xLeft = Math.max(boxA.x, boxB.x);
  const yTop = Math.max(boxA.y, boxB.y);
  const xRight = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
  const yBottom = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

  if (xRight <= xLeft || yBottom <= yTop) {
    return 0.0;
  }

  const intersectionArea = (xRight - xLeft) * (yBottom - yTop);
  const areaA = boxA.width * boxA.height;
  const areaB = boxB.width * boxB.height;
  const minArea = Math.min(areaA, areaB);

  return minArea > 0 ? intersectionArea / minArea : 0.0;
}

/**
 * Correlates and deduplicates DOM sensitive findings and visual findings.
 */
export function correlateFindings(
  domElements: ScannedElement[],
  visualFindings: VisualFinding[]
): {
  unifiedFindings: UnifiedFinding[];
  correlatedVisualIds: Set<string>;
} {
  const unifiedFindings: UnifiedFinding[] = [];
  const correlatedVisualIds = new Set<string>();

  // 1. Process DOM elements
  for (const el of domElements) {
    const isSensitive = el.sensitivity.isSensitive || el.sensitivity.type !== SensitiveElementType.NONE;
    if (!isSensitive) continue;

    const category = el.sensitivity.type;
    let matchingVisual: VisualFinding | undefined;

    // Check for spatial overlap with visual findings
    for (const vf of visualFindings) {
      if (correlatedVisualIds.has(vf.id)) continue;

      const overlap = calculateBoxOverlap(el.bounds, vf.pageBoundingBox);
      if (overlap > 0.25) {
        // High spatial correlation
        matchingVisual = vf;
        correlatedVisualIds.add(vf.id);
        break;
      }
    }

    if (matchingVisual) {
      unifiedFindings.push({
        id: `uf-corr-${el.elementId}-${matchingVisual.id}`,
        source: 'correlated',
        category,
        confidence: Math.max(el.sensitivity.confidence, matchingVisual.confidence),
        elementId: el.elementId,
        bounds: el.bounds,
        decision: 'REDACTED',
        reasons: [
          ...el.sensitivity.reasons,
          `Correlated with visual finding ${matchingVisual.id} (${overlapSummary(matchingVisual)})`,
        ],
        maskToken: REDACTION_TOKENS[category] || REDACTION_TOKENS[SensitiveElementType.UNKNOWN],
      });
    } else {
      unifiedFindings.push({
        id: `uf-dom-${el.elementId}`,
        source: 'dom',
        category,
        confidence: el.sensitivity.confidence,
        elementId: el.elementId,
        bounds: el.bounds,
        decision: 'REDACTED',
        reasons: el.sensitivity.reasons,
        maskToken: REDACTION_TOKENS[category] || REDACTION_TOKENS[SensitiveElementType.UNKNOWN],
      });
    }
  }

  // 2. Add remaining uncorrelated visual findings (e.g. text in canvas or static image)
  for (const vf of visualFindings) {
    if (correlatedVisualIds.has(vf.id)) continue;

    unifiedFindings.push({
      id: `uf-vis-${vf.id}`,
      source: 'visual',
      category: vf.category,
      confidence: vf.confidence,
      bounds: vf.pageBoundingBox,
      decision: 'REDACTED',
      reasons: vf.reasons,
      maskToken: REDACTION_TOKENS[vf.category] || REDACTION_TOKENS[SensitiveElementType.UNKNOWN],
    });
  }

  return { unifiedFindings, correlatedVisualIds };
}

function overlapSummary(vf: VisualFinding): string {
  return `category: ${vf.category}, conf: ${vf.confidence.toFixed(2)}`;
}

/**
 * UNIFIED PRIVACY FIREWALL: runPrivacyFirewall()
 *
 * Combines DOM scanning, visual perception, policy evaluation, and redaction.
 * Produces the final UnifiedSanitizedContext.
 *
 * FAIL-CLOSED:
 * Any error or malformed input immediately triggers a fail-closed result.
 */
export function runPrivacyFirewall(
  domScan: DomScanResult | null | undefined,
  visualScan?: VisualScanResult | null
): UnifiedSanitizedContext {
  try {
    if (!domScan || !Array.isArray(domScan.elements)) {
      throw new Error('Invalid or missing DOM scan result');
    }

    // 1. Run DOM sanitization boundary
    const sanitizedDom = prepareSanitizedContext(domScan);
    if (sanitizedDom.isFailClosed) {
      throw new Error('DOM preparation failed closed');
    }

    const visualFindings = visualScan?.findings || [];

    // 2. Correlate and deduplicate findings
    const { unifiedFindings } = correlateFindings(domScan.elements, visualFindings);

    // 3. Prepare sanitized visual regions
    const sanitizedVisualRegions: SanitizedVisualRegion[] = visualFindings.map((vf) => ({
      id: vf.id,
      category: vf.category,
      confidence: vf.confidence,
      bounds: vf.pageBoundingBox,
      decision: 'REDACTED',
    }));

    // 4. Compute privacy coverage & summary
    const unknownCount = unifiedFindings.filter(
      (f) => f.category === SensitiveElementType.UNKNOWN
    ).length;
    const redactedCount = unifiedFindings.filter((f) => f.decision === 'REDACTED').length;
    const blockedCount = unifiedFindings.filter((f) => f.decision === 'BLOCKED').length;
    const totalSensitive = unifiedFindings.length;

    const allowedControls = sanitizedDom.elements.filter(
      (e) => e.decision === 'ALLOWED' && e.interactable
    ).length;

    const redactionCoverage =
      totalSensitive === 0 ? 1.0 : (redactedCount + blockedCount) / totalSensitive;

    return {
      pageUrl: sanitizedDom.pageUrl,
      pageTitle: sanitizedDom.pageTitle,
      timestamp: sanitizedDom.timestamp,
      elements: sanitizedDom.elements,
      visualRegions: sanitizedVisualRegions,
      unifiedFindings,
      summary: {
        totalElements: sanitizedDom.elements.length,
        totalVisualFindings: visualFindings.length,
        totalSensitiveRegions: totalSensitive,
        redactedCount,
        blockedCount,
        unknownCount,
        allowedControls,
      },
      redactionCoverage: Math.min(1.0, Math.max(0.0, redactionCoverage)),
      isFailClosed: false,
    };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : 'Unknown firewall failure';

    // Absolute Fail-Closed: return completely locked-down empty context
    return {
      pageUrl: '',
      pageTitle: '',
      timestamp: Date.now(),
      elements: [],
      visualRegions: [],
      unifiedFindings: [],
      summary: {
        totalElements: 0,
        totalVisualFindings: 0,
        totalSensitiveRegions: 0,
        redactedCount: 0,
        blockedCount: 0,
        unknownCount: 0,
        allowedControls: 0,
      },
      redactionCoverage: 1.0,
      isFailClosed: true,
      failureReason: errMessage,
    };
  }
}
