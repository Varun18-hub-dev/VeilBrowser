import { SensitiveElementType } from '@veilbrowse/shared-types';
import {
  type OcrToken,
  detectVisualSensitiveRegions,
  mapCoordinates,
  applyVisualRedaction,
  scanVisual,
} from '../content/visual-scanner';

describe('Phase 5: Local Visual Perception & Redaction', () => {
  const coordContext = {
    devicePixelRatio: 2,
    scrollX: 100,
    scrollY: 200,
    viewportWidth: 1280,
    viewportHeight: 720,
  };

  const syntheticTokens: OcrToken[] = [
    {
      text: 'contact@privatecorp.io',
      bbox: { x: 200, y: 100, width: 300, height: 40 },
    },
    {
      text: '+1 (555) 432-8765',
      bbox: { x: 200, y: 160, width: 250, height: 40 },
    },
    {
      text: 'SSN: 123-45-6789',
      bbox: { x: 200, y: 220, width: 280, height: 40 },
    },
    {
      text: '4532 8901 2345 6789',
      bbox: { x: 200, y: 280, width: 320, height: 40 },
    },
    {
      text: '742 Evergreen Terrace, Springfield',
      bbox: { x: 200, y: 340, width: 400, height: 40 },
    },
    {
      text: 'password: SecretVisualPassword123',
      bbox: { x: 200, y: 400, width: 350, height: 40 },
    },
    {
      text: 'Welcome to our dashboard! View reports below.',
      bbox: { x: 200, y: 20, width: 500, height: 40 },
    },
    {
      text: 'Click here to save settings',
      bbox: { x: 200, y: 500, width: 200, height: 40 },
    },
  ];

  test('detects sensitive visual regions accurately from tokens', () => {
    const findings = detectVisualSensitiveRegions(syntheticTokens, coordContext);

    // 6 sensitive tokens, 2 safe tokens
    expect(findings).toHaveLength(6);

    const categories = findings.map((f) => f.category);
    expect(categories).toContain(SensitiveElementType.EMAIL);
    expect(categories).toContain(SensitiveElementType.PHONE);
    expect(categories).toContain(SensitiveElementType.IDENTITY);
    expect(categories).toContain(SensitiveElementType.PAYMENT);
    expect(categories).toContain(SensitiveElementType.ADDRESS);
    expect(categories).toContain(SensitiveElementType.PASSWORD);
  });

  test('coordinate mapping correctly converts screenshot -> viewport -> page coordinates', () => {
    const rawBbox = { x: 200, y: 100, width: 300, height: 40 };
    const { viewport, page } = mapCoordinates(rawBbox, coordContext);

    // DPR is 2 -> viewport should be half
    expect(viewport).toEqual({
      x: 100,
      y: 50,
      width: 150,
      height: 20,
    });

    // Page = viewport + scroll (scrollX: 100, scrollY: 200)
    expect(page).toEqual({
      x: 200,
      y: 250,
      width: 150,
      height: 20,
    });
  });

  test('applies visual redaction on canvas context', () => {
    const fillRectMock = jest.fn();
    const mockCanvas = {
      getContext: jest.fn().mockReturnValue({
        fillStyle: '',
        fillRect: fillRectMock,
      }),
    };

    const findings = detectVisualSensitiveRegions(syntheticTokens, coordContext);
    const redactedFindings = applyVisualRedaction(mockCanvas, findings);

    expect(fillRectMock).toHaveBeenCalledTimes(6);
    expect(redactedFindings.every((f) => f.redacted)).toBe(true);
  });

  test('PRIVACY INVARIANT: raw OCR text does NOT enter visual findings or outbound payload', () => {
    const result = scanVisual(syntheticTokens, coordContext, 1920, 1080);
    const serialized = JSON.stringify(result);

    // Assert that raw synthetic secrets NEVER appear in the outbound visual payload
    expect(serialized).not.toContain('contact@privatecorp.io');
    expect(serialized).not.toContain('SecretVisualPassword123');
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toContain('4532 8901 2345 6789');
    expect(serialized).not.toContain('+1 (555) 432-8765');
    expect(serialized).not.toContain('742 Evergreen Terrace');

    // Findings contain only metadata
    expect(result.findings[0]).toHaveProperty('id');
    expect(result.findings[0]).toHaveProperty('category');
    expect(result.findings[0]).toHaveProperty('confidence');
    expect(result.findings[0]).toHaveProperty('boundingBox');
    expect(result.findings[0]).toHaveProperty('reasons');
    expect(result.findings[0]).not.toHaveProperty('text');
  });
});
