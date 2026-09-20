import {
  SensitiveElementType,
  type UnifiedSanitizedContext,
  type SanitizedElement,
  type SanitizedVisualRegion,
} from '@veilbrowse/shared-types';
import { validateAction, executeAction } from '../content/action-validator';

describe('Phase 7: Local Action Validation & Execution Boundary', () => {
  const mockSafeButton: SanitizedElement = {
    elementId: 'vb-save-btn',
    tagName: 'button',
    role: 'button',
    category: SensitiveElementType.NONE,
    decision: 'ALLOWED',
    accessibleLabel: 'Save Notification Preferences',
    interactable: true,
    bounds: { x: 100, y: 100, width: 200, height: 50 },
  };

  const mockPasswordInput: SanitizedElement = {
    elementId: 'vb-pwd',
    tagName: 'input',
    role: 'textbox',
    category: SensitiveElementType.PASSWORD,
    decision: 'REDACTED',
    maskToken: '[REDACTED_PASSWORD]',
    accessibleLabel: '[REDACTED_PASSWORD]',
    interactable: true,
    bounds: { x: 100, y: 200, width: 200, height: 40 },
  };

  const mockSensitiveVisual: SanitizedVisualRegion = {
    id: 'vf-card',
    category: SensitiveElementType.PAYMENT,
    confidence: 0.95,
    bounds: { x: 500, y: 300, width: 300, height: 60 },
    decision: 'REDACTED',
  };

  const mockContext: UnifiedSanitizedContext = {
    pageUrl: 'https://example.com/settings',
    pageTitle: 'Settings',
    timestamp: Date.now(),
    elements: [mockSafeButton, mockPasswordInput],
    visualRegions: [mockSensitiveVisual],
    unifiedFindings: [],
    summary: {
      totalElements: 2,
      totalVisualFindings: 1,
      totalSensitiveRegions: 2,
      redactedCount: 2,
      blockedCount: 0,
      unknownCount: 0,
      allowedControls: 1,
    },
    redactionCoverage: 1.0,
    isFailClosed: false,
  };

  describe('7.1 Whitelist & Malformed Payloads', () => {
    test('rejects arbitrary JavaScript actions (EXECUTE_JS, EVAL)', () => {
      const res = validateAction({ action: 'EXECUTE_JS', code: 'alert(1)' }, mockContext);
      expect(res.valid).toBe(false);
      expect(res.decision).toBe('REJECTED');
      expect(res.reasons[0]).toContain('forbidden');
    });

    test('rejects malformed payloads', () => {
      const res = validateAction(null, mockContext);
      expect(res.valid).toBe(false);
      expect(res.decision).toBe('REJECTED');
    });
  });

  describe('7.2 Sensitive Target Protection', () => {
    test('approves click on safe interactable button', () => {
      const res = validateAction({ action: 'CLICK', targetId: 'vb-save-btn' }, mockContext);
      expect(res.valid).toBe(true);
      expect(res.decision).toBe('APPROVED');
    });

    test('BLOCKS click on sensitive password input', () => {
      const res = validateAction({ action: 'CLICK', targetId: 'vb-pwd' }, mockContext);
      expect(res.valid).toBe(false);
      expect(res.decision).toBe('BLOCKED');
      expect(res.reasons[0]).toContain('sensitive (password)');
    });

    test('BLOCKS click on unknown element id', () => {
      const res = validateAction({ action: 'CLICK', targetId: 'vb-nonexistent' }, mockContext);
      expect(res.valid).toBe(false);
      expect(res.decision).toBe('BLOCKED');
      expect(res.reasons[0]).toContain('not found');
    });

    test('requires confirmation for destructive click action', () => {
      const res = validateAction(
        { action: 'CLICK', targetId: 'vb-save-btn', isDestructive: true },
        mockContext
      );
      expect(res.valid).toBe(true);
      expect(res.decision).toBe('REQUIRES_CONFIRMATION');
    });

    test('approves confirmed destructive click action', () => {
      const res = validateAction(
        { action: 'CLICK', targetId: 'vb-save-btn', isDestructive: true, confirmedByUser: true },
        mockContext
      );
      expect(res.valid).toBe(true);
      expect(res.decision).toBe('APPROVED');
    });
  });

  describe('7.3 Coordinate Actions', () => {
    test('approves coordinate click on safe control', () => {
      const res = validateAction(
        { action: 'CLICK', targetCoordinates: { x: 150, y: 125 } },
        mockContext
      );
      expect(res.valid).toBe(true);
      expect(res.decision).toBe('APPROVED');
    });

    test('BLOCKS coordinate click on sensitive visual region', () => {
      const res = validateAction(
        { action: 'CLICK', targetCoordinates: { x: 550, y: 320 } },
        mockContext
      );
      expect(res.valid).toBe(false);
      expect(res.decision).toBe('BLOCKED');
      expect(res.reasons[0]).toContain('detected sensitive visual region');
    });

    test('BLOCKS blind coordinate click on empty space', () => {
      const res = validateAction(
        { action: 'CLICK', targetCoordinates: { x: 10, y: 10 } },
        mockContext
      );
      expect(res.valid).toBe(false);
      expect(res.decision).toBe('BLOCKED');
      expect(res.reasons[0]).toContain('does not map to a verified safe control');
    });
  });

  describe('7.4 Navigation Safety', () => {
    test('rejects javascript: URL scheme', () => {
      const res = validateAction(
        { action: 'NAVIGATE', url: 'javascript:alert(document.cookie)' },
        mockContext
      );
      expect(res.valid).toBe(false);
      expect(res.decision).toBe('REJECTED');
      expect(res.reasons[0]).toContain('Forbidden URL scheme');
    });

    test('rejects data: URL scheme', () => {
      const res = validateAction(
        { action: 'NAVIGATE', url: 'data:text/html,<script>evil()</script>' },
        mockContext
      );
      expect(res.valid).toBe(false);
      expect(res.decision).toBe('REJECTED');
    });

    test('approves safe https: URL', () => {
      const res = validateAction(
        { action: 'NAVIGATE', url: 'https://example.com/notifications' },
        mockContext
      );
      expect(res.valid).toBe(true);
      expect(res.decision).toBe('APPROVED');
    });
  });

  describe('7.5 Bounded Scroll and Wait', () => {
    test('validates bounded scroll distance', () => {
      const res = validateAction({ action: 'SCROLL', direction: 'down', distance: 500 }, mockContext);
      expect(res.valid).toBe(true);
      expect(res.decision).toBe('APPROVED');

      const outOfBounds = validateAction(
        { action: 'SCROLL', direction: 'down', distance: 999999 },
        mockContext
      );
      expect(outOfBounds.valid).toBe(false);
      expect(outOfBounds.decision).toBe('REJECTED');
    });

    test('validates bounded wait duration', () => {
      const res = validateAction({ action: 'WAIT', durationMs: 500 }, mockContext);
      expect(res.valid).toBe(true);
      expect(res.decision).toBe('APPROVED');

      const tooLong = validateAction({ action: 'WAIT', durationMs: 999999 }, mockContext);
      expect(tooLong.valid).toBe(false);
      expect(tooLong.decision).toBe('REJECTED');
    });
  });

  describe('7.6 Execution Engine', () => {
    test('executes approved click on mock DOM element', async () => {
      const clickMock = jest.fn();
      const mockElement = { click: clickMock } as unknown as HTMLElement;

      const result = await executeAction(
        { action: 'CLICK', targetId: 'vb-save-btn' },
        mockContext,
        () => mockElement
      );

      expect(result.success).toBe(true);
      expect(clickMock).toHaveBeenCalledTimes(1);
    });

    test('throws if attempting to execute blocked action', async () => {
      await expect(
        executeAction({ action: 'CLICK', targetId: 'vb-pwd' }, mockContext)
      ).rejects.toThrow('Action execution aborted');
    });
  });
});
